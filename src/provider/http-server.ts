/**
 * Bun 1.3's node:http shim does not reliably report a disconnected streaming
 * client until the response ends. Use Bun's documented Request.signal instead;
 * Node keeps its native HTTP implementation. The adapter is transport-only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
interface BunListener { port: number; stop(force?: boolean): void | Promise<void> }
interface BunRuntime {
  serve(options: { hostname: string; port: number; idleTimeout: number; fetch(req: Request): Promise<Response> }): BunListener;
}

export function createProviderHttpServer(handler: Handler): Server {
  const bun = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  if (!bun) return createServer(handler);

  const facade = new EventEmitter();
  let listener: BunListener | undefined;
  const active = new Set<() => void>();
  const server = Object.assign(facade, {
    listen(port: number, hostname: string) {
      try {
        listener = bun.serve({ hostname, port, idleTimeout: 0,
          async fetch(request) {
            const url = new URL(request.url);
            const req = (request.body ? Readable.fromWeb(request.body as any) : Readable.from([])) as IncomingMessage;
            req.method = request.method;
            req.url = url.pathname + url.search;
            req.headers = Object.fromEntries(request.headers);
            const headers = new Headers();
            let status = 200;
            let controller: ReadableStreamDefaultController<Uint8Array>;
            let resolve!: (response: Response) => void;
            const response = new Promise<Response>((r) => { resolve = r; });
            let opened = false;
            let aborted = false;
            let ended = false;
            const open = () => {
              if (opened || aborted) return;
              opened = true;
              resolve(new Response(stream, { status, headers }));
            };
            const cleanup = () => {
              active.delete(abort);
              request.signal.removeEventListener("abort", abort);
            };
            const abort = () => {
              if (aborted || ended) return;
              aborted = true;
              cleanup();
              req.emit("aborted");
              res.emit("close");
              try { controller.close(); } catch { /* stream already closed */ }
              if (!opened) resolve(new Response(null, { status: 499 }));
            };
            const stream = new ReadableStream<Uint8Array>({
              start(value) { controller = value; },
              cancel() { abort(); },
            });
            const res = Object.assign(new Writable({
              write(chunk, _encoding, callback) {
                if (!aborted) { open(); controller.enqueue(new Uint8Array(chunk)); }
                callback();
              },
              final(callback) {
                if (!aborted) { open(); controller.close(); }
                ended = true;
                cleanup();
                callback();
              },
            }), {
              get headersSent() { return opened; },
              setHeader(name: string, value: string | number | readonly string[]) {
                headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
              },
              writeHead(code: number, values?: Record<string, string>) {
                status = code;
                for (const [name, value] of Object.entries(values ?? {})) headers.set(name, value);
                open();
              },
            });
            // Object.assign copies getter values; define this live property.
            Object.defineProperty(res, "headersSent", { get: () => opened });
            active.add(abort);
            request.signal.addEventListener("abort", abort, { once: true });
            if (request.signal.aborted) abort();
            else void Promise.resolve(handler(req, res as unknown as ServerResponse)).catch(() => {
              if (!opened) res.writeHead(500);
              res.end();
            });
            return response;
          },
        });
        queueMicrotask(() => facade.emit("listening"));
      } catch (error) { queueMicrotask(() => facade.emit("error", error)); }
      return server;
    },
    address() { return listener ? { port: listener.port } : null; },
    closeAllConnections() { for (const abort of [...active]) abort(); },
    close(callback?: () => void) {
      server.closeAllConnections();
      void Promise.resolve(listener?.stop(true)).then(() => callback?.());
      return server;
    },
  });
  return server as unknown as Server;
}

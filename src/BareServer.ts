import type { LookupOneOptions } from "node:dns";
import EventEmitter from "node:events";
import { readFileSync } from "node:fs";
import type { Agent as HttpAgent, IncomingMessage, ServerResponse } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { join } from "node:path";
import {
  pipeline,
  Readable,
  Transform,
  Writable,
  type Duplex,
  type TransformCallback,
} from "node:stream";
import type { ReadableStream } from "node:stream/web";

import createHttpError from "http-errors";
import type WebSocket from "ws";
// @internal
import type { JSONDatabaseAdapter } from "./Meta.js";
import { nullMethod } from "./requestUtil.js";

export interface BareRequest extends Request {
  native: IncomingMessage;
}

export interface BareErrorBody {
  code: string;
  id: string;
  message?: string;
  stack?: string;
}

export class BareError extends Error {
  status: number;
  body: BareErrorBody;
  constructor(status: number, body: BareErrorBody) {
    super(body.message || body.code);
    this.status = status;
    this.body = body;
  }
}

export const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
) as { version: string };

const project: BareProject = {
  name: "bare-server-node",
  description: "TOMPHTTP NodeJS Bare Server",
  repository: "https://github.com/tomphttp/bare-server-node",
  version: pkg.version,
};

export function json<T>(status: number, json: T) {
  const send = Buffer.from(JSON.stringify(json, null, "\t"));

  return new Response(send, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": send.byteLength.toString(),
    },
  });
}

export type BareMaintainer = {
  email?: string;
  website?: string;
};

export type BareProject = {
  name?: string;
  description?: string;
  email?: string;
  website?: string;
  repository?: string;
  version?: string;
};

export type BareLanguage =
  | "NodeJS"
  | "ServiceWorker"
  | "Deno"
  | "Java"
  | "PHP"
  | "Rust"
  | "C"
  | "C++"
  | "C#"
  | "Ruby"
  | "Go"
  | "Crystal"
  | "Shell"
  | string;

export type BareManifest = {
  maintainer?: BareMaintainer;
  project?: BareProject;
  versions: string[];
  language: BareLanguage;
  memoryUsage?: number;
};

export interface Options {
  logErrors: boolean;
  /**
   * Callback for filtering the remote URL.
   * @returns Nothing
   * @throws An error if the remote is bad.
   */
  filterRemote?: (remote: Readonly<URL>) => Promise<void> | void;
  // 用于检查敏感词的回调函数
  filterBody?: (chunk: string) => string;
  checkBody?: (chunk: string) => boolean;
  /**
   * DNS lookup
   * May not get called when remote.host is an IP
   * Use in combination with filterRemote to block IPs
   */
  lookup: (
    hostname: string,
    options: LookupOneOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void,
  ) => void;
  localAddress?: string;
  family?: number;
  maintainer?: BareMaintainer;
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
  database: JSONDatabaseAdapter;
  wss: WebSocket.Server;
}

export type RouteCallback = (
  request: BareRequest,
  response: ServerResponse<IncomingMessage>,
  options: Options,
) => Promise<Response> | Response;

export type SocketRouteCallback = (
  request: BareRequest,
  socket: Duplex,
  head: Buffer,
  options: Options,
) => Promise<void> | void;

// 自定义 Transform 流，用于敏感词检查
class SensitiveWordChecker extends Transform {
  private checkFn: (chunk: string) => string;

  constructor(checkFn: (chunk: string) => string) {
    super();
    this.checkFn = checkFn;
  }
  private validEncodings: BufferEncoding[] = ["utf8", "ascii", "base64", "hex"];
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    // if (!this.validEncodings.includes(encoding as BufferEncoding)) {
    //   this.push(chunk);
    //   callback();
    //   return;
    // }
    // try {
    // 将数据块转换为字符串
    const chunkString = chunk.toString();

    // 使用传入的回调函数进行敏感词检查
    let result = chunkString;
    if (this.checkFn) {
      result = this.checkFn(chunkString);
    }

    // 将处理后的字符串转换回 Buffer
    const resultBuffer = Buffer.from(result);

    // 将处理后的数据块推送到下一个流
    this.push(resultBuffer);
    callback();
    // } catch (error) {
    //   // Handle any errors that occur during processing
    //   callback(error);
    // }
  }
}

export default class Server extends EventEmitter {
  directory: string;
  routes = new Map<string, RouteCallback>();
  socketRoutes = new Map<string, SocketRouteCallback>();
  versions: string[] = [];
  private closed = false;
  private options: Options;
  /**
   * @internal
   */
  constructor(directory: string, options: Options) {
    super();
    this.directory = directory;
    this.options = options;
  }
  /**
   * Remove all timers and listeners
   */
  close() {
    this.closed = true;
    this.emit("close");
  }
  shouldRoute(request: IncomingMessage): boolean {
    return (
      !this.closed &&
      request.url !== undefined &&
      request.url.startsWith(this.directory)
    );
  }
  get instanceInfo(): BareManifest {
    return {
      versions: this.versions,
      language: "NodeJS",
      memoryUsage:
        Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
      maintainer: this.options.maintainer,
      project,
    };
  }
  async routeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const request = new Request(new URL(req.url!, "http://bare-server-node"), {
      method: req.method,
      body: nullMethod.includes(req.method || "") ? undefined : req,
      headers: req.headers as HeadersInit,
    }) as BareRequest;

    request.native = req;

    const service = new URL(request.url).pathname.slice(this.directory.length - 1);

    if (this.socketRoutes.has(service)) {
      const call = this.socketRoutes.get(service)!;

      try {
        await call(request, socket, head, this.options);
      } catch (error) {
        if (this.options.logErrors) {
          console.error(error);
        }

        socket.end();
      }
    } else {
      socket.end();
    }
  }

  // 异步读取 response.body 到字符串
  async readResponseBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable");
    }

    const decoder = new TextDecoder();
    let result = "";
    let done = false;

    while (!done) {
      const { value, done: readDone } = await reader.read();
      done = readDone;
      if (value) {
        result += decoder.decode(value, { stream: true });
      }
    }

    return result;
  }

  // 将字符串写入 res
  writeStringToResponse(str: string, res: Writable) {
    // 需要将字符串转换为 Buffer 或可写入流的格式
    res.write(str, "utf8", () => {
      res.end();
    });
  }

  async routeRequest(req: IncomingMessage, res: ServerResponse) {
    const request = new Request(new URL(req.url!, "http://bare-server-node"), {
      method: req.method,
      body: nullMethod.includes(req.method || "") ? undefined : req,
      headers: req.headers as HeadersInit,
      duplex: "half",
    }) as BareRequest;

    request.native = req;

    const service = new URL(request.url).pathname.slice(this.directory.length - 1);
    let response: Response;

    try {
      if (request.method === "OPTIONS") {
        response = new Response(undefined, { status: 200 });
      } else if (service === "/") {
        response = json(200, this.instanceInfo);
      } else if (this.routes.has(service)) {
        const call = this.routes.get(service)!;
        response = await call(request, res, this.options);
      } else {
        throw new createHttpError.NotFound();
      }
    } catch (error) {
      if (this.options.logErrors) console.error(error);

      if (createHttpError.isHttpError(error)) {
        response = json(error.statusCode, {
          code: "UNKNOWN",
          id: `error.${error.name}`,
          message: error.message,
          stack: error.stack,
        });
      } else if (error instanceof Error) {
        response = json(500, {
          code: "UNKNOWN",
          id: `error.${error.name}`,
          message: error.message,
          stack: error.stack,
        });
      } else {
        response = json(500, {
          code: "UNKNOWN",
          id: "error.Exception",
          message: error,
          stack: new Error(<string | undefined>error).stack,
        });
      }

      if (!(response instanceof Response)) {
        if (this.options.logErrors) {
          console.error(
            "Cannot",
            request.method,
            new URL(request.url).pathname,
            ": Route did not return a response.",
          );
        }

        throw new createHttpError.InternalServerError();
      }
    }

    response.headers.set("x-robots-tag", "noindex");
    response.headers.set("access-control-allow-headers", "*");
    response.headers.set("access-control-allow-origin", "*");
    response.headers.set("access-control-allow-methods", "*");
    response.headers.set("access-control-expose-headers", "*");
    // don't fetch preflight on every request...
    // instead, fetch preflight every 10 minutes
    response.headers.set("access-control-max-age", "7200");

    let bodyString = "";
    let hasSensitive = false;
    if (response.body) {
      // console.info("x-bare-headers", response.headers.get("x-bare-headers"));
      try {
        // 读取 response.body 到字符串
        bodyString = await this.readResponseBody(response);

        if (this.options.checkBody) {
          // response.body;
          if (this.options.checkBody(bodyString)) {
            // response = new Response(undefined, { status: 404 });
            hasSensitive = true;
          }
        }
      } catch (error) {
        console.error("Error processing response:", error);
        res.destroy(); // 销毁 res 流以处理错误
      }
    }

    if (hasSensitive) {
      const send = Buffer.from(
        JSON.stringify(
          {
            code: "UNKNOWN",
            id: "error.Exception",
            message: "⚠️⚠️⚠️⚠️⚠️⚠️Access Denied⚠️⚠️⚠️⚠️⚠️⚠️",
            stack: new Error(<string | undefined>"access denied").stack,
          },
          null,
          "\t",
        ),
      );
      const headers = {
        "content-type": "application/json",
        "content-length": send.byteLength.toString(),
      };
      res.writeHead(404, "access denied", headers);

      res.write(send, "utf8", () => {
        res.end();
      });
      return;
    }

    res.writeHead(
      response.status,
      response.statusText,
      Object.fromEntries(response.headers),
    );

    if (response.body) {
      // console.info("x-bare-headers", response.headers.get("x-bare-headers"));
      try {
        // 将字符串写入到 res
        this.writeStringToResponse(bodyString, res);
      } catch (error) {
        console.error("Error processing response:", error);
        res.destroy(); // 销毁 res 流以处理错误
      }

      // const body = Readable.fromWeb(response.body as ReadableStream);
      // // body.pipe(res);

      // // 创建敏感词检查器，并传入检查回调函数
      // const checker = new SensitiveWordChecker(this.options.filterBody!);

      // // 将响应体流数据先通过检查器，然后再传递给 `res` 流
      // body.pipe(checker).pipe(res);

      // // 使用 pipeline 连接流，并添加错误处理
      // pipeline(body, checker, res, err => {
      //   if (err) {
      //     console.error("Pipeline failed:", err);
      //   } else {
      //     console.log("Pipeline succeeded.");
      //   }
      // });

      // // 创建 PassThrough 流，用于记录日志或其他处理
      // // const passThrough = new PassThrough();
      // res.on("close", () => body.destroy());
    } else res.end();
  }
}

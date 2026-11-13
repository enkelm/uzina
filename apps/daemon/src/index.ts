import { createDaemonServer } from "./server";

const port = Number(Bun.env.PORT ?? "8788");
const hostname = Bun.env.HOST ?? "127.0.0.1";
const server = createDaemonServer(port, hostname);

console.log(`Uzina daemon listening at ${server.url}`);

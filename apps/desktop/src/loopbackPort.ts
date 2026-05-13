import * as Net from "node:net";

export async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = Net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (port <= 0) {
          reject(new Error("Failed to reserve a local loopback port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

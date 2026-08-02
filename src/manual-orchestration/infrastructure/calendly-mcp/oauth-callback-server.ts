import {
  createServer,
  type Server,
} from "node:http";

type OAuthCallbackServer = {
  waitForCode: Promise<string>;
  close: () => Promise<void>;
};

export async function
createOAuthCallbackServer(
  callbackUrl: string,
): Promise<OAuthCallbackServer> {
  const url = new URL(callbackUrl);

  if (
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost"
  ) {
    throw new Error(
      "The lab OAuth callback must use localhost.",
    );
  }

  let resolveCode:
    (code: string) => void;

  let rejectCode:
    (error: Error) => void;

  const waitForCode =
    new Promise<string>(
      (resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      },
    );

  const server: Server =
    createServer(
      (request, response) => {
        try {
          const requestUrl =
            new URL(
              request.url ?? "/",
              callbackUrl,
            );

          if (
            requestUrl.pathname !==
            url.pathname
          ) {
            response.writeHead(404);
            response.end("Not found.");
            return;
          }

          const oauthError =
            requestUrl.searchParams.get(
              "error",
            );

          if (oauthError) {
            rejectCode(
              new Error(
                `Calendly authorization failed: ${oauthError}`,
              ),
            );

            response.writeHead(400, {
              "Content-Type":
                "text/plain; charset=utf-8",
            });

            response.end(
              "Calendly authorization failed.",
            );

            return;
          }

          const code =
            requestUrl.searchParams.get(
              "code",
            );

          if (!code) {
            rejectCode(
              new Error(
                "Calendly did not return an authorization code.",
              ),
            );

            response.writeHead(400);
            response.end(
              "Missing authorization code.",
            );

            return;
          }

          resolveCode(code);

          response.writeHead(200, {
            "Content-Type":
              "text/plain; charset=utf-8",
          });

          response.end(
            "Calendly connected successfully. You may close this window.",
          );
        } catch (error) {
          rejectCode(
            error instanceof Error
              ? error
              : new Error(
                  "OAuth callback failed.",
                ),
          );

          response.writeHead(500);
          response.end(
            "Calendly connection failed.",
          );
        }
      },
    );

  await new Promise<void>(
    (resolve, reject) => {
      server.once("error", reject);

      server.listen(
        Number(url.port) || 8787,
        url.hostname,
        () => resolve(),
      );
    },
  );

  return {
    waitForCode,

    close: () =>
      new Promise<void>(
        (resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        },
      ),
  };
}
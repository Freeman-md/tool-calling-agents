import {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";

import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";

import {
  CalendlyOAuthProvider,
} from "./oauth-provider";

import {
  createOAuthCallbackServer,
} from "./oauth-callback-server";

export type CalendlyMcpConnection = {
  client: Client;
  close: () => Promise<void>;
};

export async function
connectCalendlyMcp():
Promise<CalendlyMcpConnection> {
  const serverUrl =
    process.env.CALENDLY_MCP_URL ??
    "https://mcp.calendly.com";

  const callbackUrl =
    process.env
      .CALENDLY_MCP_CALLBACK_URL ??
    "http://127.0.0.1:8787/callback";

  const authFilePath =
    process.env
      .CALENDLY_MCP_AUTH_FILE ??
    ".data/calendly-auth.json";

  const authProvider =
    new CalendlyOAuthProvider(
      callbackUrl,
      authFilePath,
    );

  const client =
    new Client({
      name:
        "freeman-tool-calling-lab",

      version: "1.0.0",
    });

  const transport =
    new StreamableHTTPClientTransport(
      new URL(serverUrl),
      {
        authProvider,
      },
    );

  try {
    await client.connect(transport);
  } catch (error) {
    if (
      !(error instanceof
        UnauthorizedError)
    ) {
      throw error;
    }

    const callback =
      await createOAuthCallbackServer(
        callbackUrl,
      );

    try {
      /*
       * Connecting again starts the OAuth
       * process and invokes
       * redirectToAuthorization().
       */
      const connectionAttempt =
        client.connect(transport);

      const authorizationCode =
        await callback.waitForCode;

      await transport.finishAuth(
        authorizationCode,
      );

      await connectionAttempt.catch(
        () => undefined,
      );

      await client.connect(transport);
    } finally {
      await callback.close();
    }
  }

  return {
    client,

    close: async () => {
      await client.close();
    },
  };
}
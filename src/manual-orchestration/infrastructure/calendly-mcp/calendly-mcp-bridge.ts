import type {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";

import type {
  OpenAI,
} from "openai/client.js";

const ALLOWED_CALENDLY_TOOLS =
  new Set([
    "event_types-list_event_types",
    "event_types-get_event_type",
    "event_types-list_event_type_available_times",
    "meetings-create_invitee",
  ]);

const APPROVAL_REQUIRED_TOOLS =
  new Set([
    "meetings-create_invitee",
  ]);

export type CalendlyMcpResult = {
  ok: boolean;
  content: unknown;
};

export class CalendlyMcpBridge {
  private constructor(
    private readonly client: Client,

    public readonly tools:
      OpenAI.Responses.FunctionTool[],

    private readonly discoveredToolNames:
      Set<string>,
  ) {}

  public static async create(
    client: Client,
  ): Promise<CalendlyMcpBridge> {
    const result =
      await client.listTools();

    const allowedTools =
      result.tools.filter((tool) =>
        ALLOWED_CALENDLY_TOOLS.has(
          tool.name,
        ),
      );

    const missingTools =
      [...ALLOWED_CALENDLY_TOOLS]
        .filter(
          (name) =>
            !allowedTools.some(
              (tool) =>
                tool.name === name,
            ),
        );

    if (missingTools.length > 0) {
      throw new Error(
        `Calendly MCP tools missing: ${missingTools.join(", ")}`,
      );
    }

    const openAiTools:
      OpenAI.Responses.FunctionTool[] =
        allowedTools.map((tool) => ({
          type: "function",

          name: tool.name,

          description:
            tool.description ??
            `Calendly MCP tool: ${tool.name}`,

          parameters:
            tool.inputSchema as
              OpenAI.Responses.FunctionTool[
                "parameters"
              ],

          /*
           * MCP schemas are owned by Calendly.
           * Do not force OpenAI strict mode
           * unless every discovered schema
           * satisfies strict requirements.
           */
          strict: false,
        }));

    return new CalendlyMcpBridge(
      client,
      openAiTools,
      new Set(
        allowedTools.map(
          (tool) => tool.name,
        ),
      ),
    );
  }

  public ownsTool(
    name: string,
  ): boolean {
    return this
      .discoveredToolNames
      .has(name);
  }

  public requiresApproval(
    name: string,
  ): boolean {
    return APPROVAL_REQUIRED_TOOLS
      .has(name);
  }

  public async execute(
    name: string,
    rawArguments: string,
  ): Promise<CalendlyMcpResult> {
    if (!this.ownsTool(name)) {
      return {
        ok: false,
        content:
          `Unknown Calendly tool: ${name}`,
      };
    }

    let argumentsValue:
      Record<string, unknown>;

    try {
      const parsed: unknown =
        JSON.parse(rawArguments);

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error(
          "Arguments must be an object.",
        );
      }

      argumentsValue =
        parsed as
          Record<string, unknown>;
    } catch {
      return {
        ok: false,
        content:
          "Calendly tool arguments were invalid JSON.",
      };
    }

    try {
      const result =
        await this.client.callTool({
          name,
          arguments:
            argumentsValue,
        });

      return {
        ok: !result.isError,
        content: result.content,
      };
    } catch (error) {
      console.error(
        `Calendly MCP tool failed: ${name}`,
        error,
      );

      return {
        ok: false,
        content:
          "Calendly could not complete the request.",
      };
    }
  }
}
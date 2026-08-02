import {
  connectCalendlyMcp,
} from "../infrastructure/calendly-mcp/calendly-mcp-client";

async function main() {
  const connection =
    await connectCalendlyMcp();

  try {
    const tools =
      await connection.client
        .listTools();

    console.log(
      "\nCalendly connected.",
    );

    console.log(
      "\nAvailable tools:",
    );

    for (
      const tool of tools.tools
    ) {
      console.log(
        `- ${tool.name}`,
      );
    }
  } finally {
    await connection.close();
  }
}

main();
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const openai_1 = __importDefault(require("openai"));
const zod_1 = require("zod");
const ResponseInputItems_1 = require("openai/lib/responses/ResponseInputItems");
const openai = new openai_1.default();
const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const FindSlotsArguments = zod_1.z.object({
    timezone: zod_1.z.string().min(1),
    duration_minutes: zod_1.z.union([
        zod_1.z.literal(30),
        zod_1.z.literal(45),
        zod_1.z.literal(60),
    ])
});
const tools = [
    {
        type: "function",
        name: 'find_consultation_slots',
        description: "Find available consultation times. This is read-only and does not create a booking. Call it only after the user's IANA timezone and preferred duration are known.",
        parameters: {
            type: "object",
            properties: {
                timezone: {
                    type: "string",
                    description: "The user's IANA timezone, for example Europe/London.",
                },
                duration_minutes: {
                    type: "integer",
                    enum: [30, 45, 60],
                    description: "Requested consultation duration.",
                },
            },
            required: ["timezone", "duration_minutes"],
            additionalProperties: false,
        },
        strict: true
    }
];
async function findConsultationSlots(input) {
    return {
        ok: true,
        timezone: input.timezone,
        duration_minutes: input.duration_minutes,
        slots: [
            {
                id: "slot_001",
                starts_at: "2026-07-28T10:00:00+01:00",
            },
            {
                id: "slot_002",
                starts_at: "2026-07-28T14:30:00+01:00",
            },
            {
                id: "slot_003",
                starts_at: "2026-07-29T11:00:00+01:00",
            },
        ]
    };
}
async function executeTool(name, rawArguments) {
    if (name !== "find_consultation_slots") {
        return {
            ok: false,
            code: "UNKNOWN_TOOL",
            message: `Unknown tool: ${name}`
        };
    }
    const parsed = FindSlotsArguments.safeParse(JSON.parse(rawArguments));
    if (!parsed.success) {
        return {
            ok: false,
            code: "INVALID_ARGUMENTS",
            message: parsed.error.message
        };
    }
    return findConsultationSlots(parsed.data);
}
async function main() {
    const userMessage = process.argv.slice(2).join(" ") ||
        "I want a 30-minute consultation. I am in Europe/London.";
    const input = [
        {
            role: "user",
            content: userMessage
        }
    ];
    for (let turn = 0; turn < 4; turn += 1) {
        const response = await openai.responses.create({
            model,
            instructions: `
            You are a consultation assistant.

Use find_consultation_slots only when the user's timezone and
preferred duration are known.

When required information is missing, ask one concise follow-up
question instead of guessing.

You can search availability, but you cannot create bookings.
Never claim that a booking has been made.
            `.trim(),
            input,
            tools,
            parallel_tool_calls: false,
        });
        input.push(...(0, ResponseInputItems_1.toResponseInputItems)(response.output));
        const toolCalls = response.output.filter((item) => item.type === "function_call");
        if (toolCalls.length === 0) {
            console.log("\nAssistant:");
            console.log(response.output_text);
            return;
        }
        for (const toolCall of toolCalls) {
            console.log(`\nCalling tool: ${toolCall.name}`);
            console.log(`Arguments: ${toolCall.arguments}`);
            const result = await executeTool(toolCall.name, toolCall.arguments);
            console.log("Result:", result);
            input.push({
                type: "function_call_output",
                call_id: toolCall.call_id,
                output: JSON.stringify(result)
            });
        }
    }
    throw new Error("Maximum tool turns exceeded.");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

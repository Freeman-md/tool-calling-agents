import {
    Agent,
} from "@openai/agents";

import type {
    AgentsBookingService,
} from "../application/booking-service";
import { buildInstructions } from "./instructions";
import { bookConsultation, findConsultationSlots } from "./tools";

export function createConsultationAgent(
    service: AgentsBookingService,
    model: string,
) {
    return new Agent({
        name:
            "Consultation booking assistant",

        model,

        instructions: () =>
            buildInstructions(service),

        tools: [
            findConsultationSlots(service),
            bookConsultation(service),
        ],

        modelSettings: {
            parallelToolCalls: false,
        },
    });
}

export type ConsultationAgent =
    ReturnType<
        typeof createConsultationAgent
    >;
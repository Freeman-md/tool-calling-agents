import { tool } from "@openai/agents-core";
import { AgentsBookingService } from "../application/booking-service";
import { BookConsultationArguments, FindSlotsArguments } from "../domain/schemas";

export const findConsultationSlots = (service: AgentsBookingService) => tool({
    name:
        "find_consultation_slots",

    description:
        "Find currently available consultation slots. This is read-only and does not reserve or create a booking.",

    parameters: FindSlotsArguments,

    execute: async (input) => {
        console.log(
            "\n[SDK executing find_consultation_slots]",
        );

        console.log(input);

        return service.findAvailableSlots(
            input,
        );
    },
});

export const bookConsultation = (service: AgentsBookingService) => tool({
    name: "book_consultation",

    description:
        "Create a consultation booking using a slot from the latest availability result. This changes external state and requires explicit human approval.",

    parameters:
        BookConsultationArguments,

    needsApproval: true,

    execute: async (input) => {
        console.log(
            "\n[SDK executing book_consultation]",
        );

        console.log(input);

        return service.createBooking(
            input,
        );
    },
});
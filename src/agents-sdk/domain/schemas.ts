import { z } from "zod";

export const DurationSchema = z.union([
  z.literal(30),
  z.literal(45),
  z.literal(60),
  z.literal(90),
]);

export const FindSlotsArguments = z.object({
  timezone: z.string().trim().min(1),
  duration_minutes: DurationSchema,
});

export const BookConsultationArguments =
  z.object({
    slot_id: z.string().trim().min(1),
    name: z.string().trim().min(2),
    email: z.string().trim().email(),
  });

export type FindSlotsInput = z.infer<
  typeof FindSlotsArguments
>;

export type BookConsultationInput =
  z.infer<
    typeof BookConsultationArguments
  >;
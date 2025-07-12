import { z } from 'zod';

// Simple test schema for enrichment tests
export const testEventSchema = z.object({
    title: z.string().describe("Event title"),
    speaker: z.string().describe("Speaker name"),
    venue: z.string().describe("Venue name"),
    duration: z.string().describe("Event duration").optional(),
    capacity: z.number().describe("Venue capacity").optional(),
    registration: z.string().describe("Registration requirements").optional(),
    department: z.string().describe("Academic department").optional(),
}); 
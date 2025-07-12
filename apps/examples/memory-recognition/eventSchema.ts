import { z } from 'zod';

export const event = z.object({
    titleAndDescription: z.array(z.object({
        title: z.string().describe("The name of the event"),
        description: z.string().describe("The description of the event. Get as much information as possible from the content, but do not make up any information. If not found, provide empty string."),
        language: z.string().describe("Detect and provide the language of the description (prefered) or title. Use two-letter language code (e.g., 'en', 'fr', 'de')")
    })).describe("The title and description of the event. Get as much information as possible from the content, but do not make up any information. If not found, provide empty string. Only one title and description per language is allowed."),
    duration: z.string().describe("The duration of the event (for performances, concerts, etc., not for exhibitions, fairs, etc.). Always in hours and minutes,format HH:MM. For multi-day durations, leave empty. Also if not applicable or not provided, leave empty."),
    link: z.string().describe("The link to the detailed event page, leave empty if not provided"),
    ticketLink: z.string().describe("The link to the ticket purchase page, leave empty if not provided"),
    language: z.string().describe("Main language of the event. Guess the most likely language of the event from the content, or paste empty string if not provided. Use two-letter language code (e.g., 'en', 'fr', 'de')"),
    translationLanguages: z.array(z.string().describe("Use two-letter language code (e.g., 'en', 'fr', 'de')")).describe("If event will be translated to other languages using any type of translation, including subtitles, add it to the list. Provide only if explicitly mentioned. If not found, return empty array. Use two-letter language code (e.g., 'en', 'fr', 'de')"),
    image: z.string().describe("The URL of the image of the event (usually close to the event title and may have a name or id of the event in the URL), leave empty if not provided"),
    comments: z.array(z.string()).describe("Any additional comments of the event, leave empty if not provided"),
});

export const eventRun = z.object({
    venue: z.object({
        name: z.string().describe("The name of the venue of the event (i.e where the event is held). Example: 'Albert Hall', 'Art School'. Leave empty if not provided. If not provided, we will assume that the event is held at the main venue."),
        address: z.string().describe("The address of the venue of the event. Example: '123 Main St, Anytown, USA'. IMPORTANT: This is not name of the venue. Leave empty if not provided"),
        auditorium: z.string().describe("Internal name of the location of the event with the venue, such as room or auditorium. Examples: 'Main Hall', 'Room 1', 'Auditorium 2', 'Garden'. IMPORTANT: This is not an address or name of the venue. Leave empty if not provided"),
    }),
    isFree: z.boolean().describe("If it is mentioned explicitly that the event is free, provide true, otherwise false"),
    prices: z.array(z.object({
        price: z.number().describe("The price of the event"),
        currency: z.string().describe("The currency of the price. Use three-letter currency code (e.g., 'EUR', 'USD', 'GBP')"),
        comment: z.string().describe("Any additional comments of the price or availability, leave empty if not provided"),
    })).describe("The prices of the event, leave empty if not provided"),
});

export const eventOccurence = z.object({
    date: z.string().describe("The date of the event start in format YYYY-MM-DD"),
    time: z.string().describe("The time of the event start in format HH:MM (24 hours format)"),
    isMultiDay: z.boolean().describe("If the event is held for multiple days, provide true, otherwise false"),
    endDate: z.string().describe("If the event is held for multiple days, provide the date of the event end in format YYYY-MM-DD. Leave empty if not provided"),
    description: z.string().describe("Specific description of the event occurence, leave empty if not provided"),
    isSoldOut: z.boolean().describe("If mentioned in the content that the event is sold out, provide true, otherwise false"),
    isCancelled: z.boolean().describe("If mentioned in the content that the event is cancelled, provide true, otherwise false"),
    isRescheduled: z.boolean().describe("If mentioned in the content that the event is rescheduled, provide true, otherwise false"),
});

// Complete event schema that combines all parts
export const completeEventSchema = z.object({
    ...event.shape,
    eventRun: eventRun.optional(),
    eventOccurrences: z.array(eventOccurence).optional(),
}); 
import { z } from 'zod';

export const PatientCaseSchema = z
    .object({
        id: z.string().min(1),
        age: z.number().int().nonnegative(),
        survivalProbability: z.number().min(0).max(1),
        notes: z.array(z.string()),
    })
    .strict();

export type PatientCase = z.infer<typeof PatientCaseSchema>;

export const TriageCaseBriefSchema = z
    .object({
        caseId: z.string().min(1),
        locale: z.literal('ru'),
        hospitalContext: z.string().min(1),
        scarceResource: z.literal('icu_bed'),
        patients: z.array(PatientCaseSchema).min(1),
        task: z.string().min(1),
    })
    .strict();

export type TriageCaseBrief = z.infer<typeof TriageCaseBriefSchema>;

export const InitialPositionSchema = z
    .object({
        patientId: z.string().min(1),
        rationale: z.string().min(1),
        confidence: z.number().min(0).max(1),
        changeTrigger: z.string().min(1),
    })
    .strict();

export type InitialPosition = z.infer<typeof InitialPositionSchema>;

export const CritiqueMessageSchema = z
    .object({
        targetMemberId: z.string().min(1),
        targetPositionMessageId: z.string().min(1),
        objections: z.array(z.string().min(1)).min(1),
        alternativePatientId: z.string().min(1).optional(),
        alternativeReasoning: z.string().min(1).optional(),
    })
    .strict();

export type CritiqueMessage = z.infer<typeof CritiqueMessageSchema>;

export const RevisionMessageSchema = z
    .object({
        patientId: z.string().min(1),
        changedMind: z.boolean(),
        rationale: z.string().min(1),
        confidence: z.number().min(0).max(1),
        respondsToMessageIds: z.array(z.string().min(1)).min(1),
    })
    .strict();

export type RevisionMessage = z.infer<typeof RevisionMessageSchema>;

export const FinalDecisionSchema = z
    .object({
        selectedPatientId: z.string().min(1),
        summary: z.string().min(1),
        rejectedAlternatives: z.array(
            z
                .object({
                    patientId: z.string().min(1),
                    whyNotSelected: z.string().min(1),
                })
                .strict()
        ),
        consensusLevel: z.enum(['low', 'medium', 'high']),
    })
    .strict();

export type FinalDecision = z.infer<typeof FinalDecisionSchema>;

/** Discriminated message phases for the deliberation protocol (JSON body). */
export const TriageMessageBodySchema = z.discriminatedUnion('phase', [
    z
        .object({
            phase: z.literal('triage_case_brief'),
            brief: TriageCaseBriefSchema,
        })
        .strict(),
    z
        .object({
            phase: z.literal('triage_initial_prompt'),
            promptRu: z.string().min(1),
        })
        .strict(),
    z
        .object({
            phase: z.literal('triage_initial_position'),
            position: InitialPositionSchema,
        })
        .strict(),
    z
        .object({
            phase: z.literal('triage_critique'),
            critique: CritiqueMessageSchema,
        })
        .strict(),
    z
        .object({
            phase: z.literal('triage_critique_reply'),
            replyRu: z.string().min(1),
            referencesMessageIds: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    z
        .object({
            phase: z.literal('triage_synthesis'),
            summaryRu: z.string().min(1),
            asksFinalRevision: z.literal(true),
        })
        .strict(),
    z
        .object({
            phase: z.literal('triage_final_prompt'),
            promptRu: z.string().min(1),
        })
        .strict(),
    z
        .object({
            phase: z.literal('triage_revision'),
            revision: RevisionMessageSchema,
        })
        .strict(),
    z
        .object({
            phase: z.literal('triage_final_decision'),
            decision: FinalDecisionSchema,
        })
        .strict(),
]);

export type TriageMessageBody = z.infer<typeof TriageMessageBodySchema>;

export type JsonEnvelope = {
    mimeType: 'application/json';
    body: TriageMessageBody;
};

export function jsonEnvelope(body: TriageMessageBody): JsonEnvelope {
    return { mimeType: 'application/json', body };
}

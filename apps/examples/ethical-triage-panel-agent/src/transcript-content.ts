import type { TriageCaseBrief, TriageMessageBody } from './types.js';

const WRAP_WIDTH = 70;

function wrapParagraph(text: string, width: number): string[] {
    const out: string[] = [];
    const paragraphs = text.split(/\n+/);
    for (const para of paragraphs) {
        let rest = para.trim();
        if (!rest) {
            continue;
        }
        while (rest.length > width) {
            let cut = rest.lastIndexOf(' ', width);
            if (cut <= 0) {
                cut = width;
            }
            out.push(rest.slice(0, cut).trimEnd());
            rest = rest.slice(cut).trimStart();
        }
        out.push(rest);
    }
    return out;
}

function indentBlock(label: string, text: string): string[] {
    const head = `${label}`;
    const lines = wrapParagraph(text, WRAP_WIDTH);
    if (lines.length === 0) {
        return [head];
    }
    return [head, ...lines.map((ln) => `  ${ln}`)];
}

function linesForBrief(brief: TriageCaseBrief): string[] {
    const acc: string[] = [
        `[Case ${brief.caseId}]`,
        ...indentBlock('Контекст:', brief.hospitalContext),
        ...indentBlock('Задача:', brief.task),
        '',
        'Пациенты:',
    ];
    for (const p of brief.patients) {
        acc.push(
            `  • ${p.id}: возраст ${p.age}, p(выживание)=${p.survivalProbability.toFixed(2)}`
        );
        for (const n of p.notes) {
            for (const ln of wrapParagraph(n, WRAP_WIDTH - 4)) {
                acc.push(`      ${ln}`);
            }
        }
    }
    return acc;
}

/** Wrap plain prose (e.g. moderator narration) for transcript files. */
export function formatTranscriptProse(text: string): string[] {
    return wrapParagraph(text, WRAP_WIDTH).map((ln) => `  ${ln}`);
}

/**
 * Human-readable lines for the deliberation transcript (Russian narrative text, not only IDs).
 */
export function formatTriageMessageBodyLines(body: TriageMessageBody): string[] {
    switch (body.phase) {
        case 'triage_case_brief':
            return linesForBrief(body.brief);
        case 'triage_initial_prompt':
        case 'triage_final_prompt':
            return indentBlock('Текст:', body.promptRu);
        case 'triage_initial_position': {
            const p = body.position;
            return [
                `Выбор пациента: ${p.patientId}`,
                `Уверенность: ${p.confidence.toFixed(2)}`,
                ...indentBlock('Обоснование:', p.rationale),
                ...indentBlock('Что изменило бы позицию:', p.changeTrigger),
            ];
        }
        case 'triage_critique': {
            const c = body.critique;
            const lines = [
                `Адресат (member): ${c.targetMemberId}`,
                `Ссылка на сообщение позиции: ${c.targetPositionMessageId}`,
                'Возражения:',
            ];
            c.objections.forEach((o, i) => {
                lines.push(`  ${i + 1}.`);
                for (const ln of wrapParagraph(o, WRAP_WIDTH - 2)) {
                    lines.push(`     ${ln}`);
                }
            });
            if (c.alternativePatientId !== undefined) {
                lines.push(`Альтернативный пациент: ${c.alternativePatientId}`);
            }
            if (c.alternativeReasoning !== undefined) {
                lines.push(...indentBlock('Аргументация альтернативы:', c.alternativeReasoning));
            }
            return lines;
        }
        case 'triage_critique_reply':
            return indentBlock('Ответ:', body.replyRu);
        case 'triage_synthesis':
            return [
                'Запрошена финальная ревизия: да',
                ...indentBlock('Синтез модератора:', body.summaryRu),
            ];
        case 'triage_revision': {
            const r = body.revision;
            return [
                `Итоговый пациент: ${r.patientId}`,
                `Поменял(а) мнение: ${r.changedMind ? 'да' : 'нет'}`,
                `Уверенность: ${r.confidence.toFixed(2)}`,
                `Опора на сообщения: ${r.respondsToMessageIds.join(', ')}`,
                ...indentBlock('Причина:', r.rationale),
            ];
        }
        case 'triage_final_decision': {
            const d = body.decision;
            const lines = [
                `Выбран: ${d.selectedPatientId}`,
                `Уровень консенсуса: ${d.consensusLevel}`,
                ...indentBlock('Резюме решения:', d.summary),
                '',
                'Отклонённые альтернативы:',
            ];
            for (const alt of d.rejectedAlternatives) {
                lines.push(`  • ${alt.patientId}:`);
                for (const ln of wrapParagraph(alt.whyNotSelected, WRAP_WIDTH - 4)) {
                    lines.push(`      ${ln}`);
                }
            }
            return lines;
        }
    }
}

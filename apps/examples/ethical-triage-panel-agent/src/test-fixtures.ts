import type { TriageCaseBrief, InitialPosition, CritiqueMessage, RevisionMessage, FinalDecision } from './types.js';

/** Deterministic ICU triage tension: no dominant “right” answer. */
export const defaultTriageCaseBrief: TriageCaseBrief = {
    caseId: 'icu-demo-001',
    locale: 'ru',
    hospitalContext:
        'Осталась одна койка реанимации. Нужно выбрать одного пациента сейчас; остальные остаются без ICU на этом этапе.',
    scarceResource: 'icu_bed',
    patients: [
        {
            id: 'A',
            age: 34,
            survivalProbability: 0.78,
            notes: [
                'Молодой взрослый, тяжёлая политравма после ДТП.',
                'Прогноз при ICU хороший, но выздоровление может занять месяцы.',
            ],
        },
        {
            id: 'B',
            age: 58,
            survivalProbability: 0.55,
            notes: [
                'Врач этой же больницы, септическое осложнение после операции.',
                'Средний прогноз; коллеги эмоционально вовлечены.',
            ],
        },
        {
            id: 'C',
            age: 9,
            survivalProbability: 0.42,
            notes: [
                'Ребёнок, неопределённый неврологический прогноз.',
                'Родители просят «сделать всё возможное».',
            ],
        },
        {
            id: 'D',
            age: 41,
            survivalProbability: 0.63,
            notes: [
                'Родитель-одиночка двоих детей, тяжёлая пневмония с дыхательной недостаточностью.',
                'Умеренный прогноз при ICU; сильная социальная уязвимость семьи.',
            ],
        },
    ],
    task: 'Выберите одного пациента для последней койки ICU и аргументируйте этично, по роли.',
};

export const initialPromptRu =
    'Кратко дайте стартовую позицию: предпочтительный пациент (A–D), этическое обоснование на русском, уверенность 0–1, и одно предложение: какие данные изменили бы вашу позицию.';

export const finalPromptRu =
    'Финальная ревизия: укажите итоговый выбор, изменили ли вы мнение, краткую причину, уверенность, и перечислите id сообщений, на которые опираетесь.';

export const synthesisPreambleRu = (snapshot: {
    initial: Record<string, string>;
    finalSoFar: Record<string, string>;
    consensus?: string;
}): string => {
    const ini = JSON.stringify(snapshot.initial);
    const fin = JSON.stringify(snapshot.finalSoFar);
    const maj = snapshot.consensus ?? 'нет явного большинства';
    return (
        'Промежуточный синтез модератора (без новых медицинских фактов). ' +
        `Стартовые выборы: ${ini}. Текущие финальные (если есть): ${fin}. ` +
        `Кандидат консенсуса по простому большинству: ${maj}. ` +
        'Конфликтные оси: выживаемость против справедливости, статус врача, уязвимость ребёнка, опора семьи. ' +
        'Дайте финальную ревизию позиций по инструкции раунда.'
    );
};

export const moderatorFinalSummaryRu =
    'Панель завершила протокол. Итог фиксируется в формальном решении ниже; дальнейшие посты в теме закрыты сигналом завершения.';

export const fixtureInitialBySeat = (): {
    util: InitialPosition;
    fair: InitialPosition;
    duty: InitialPosition;
    prag: InitialPosition;
} => ({
    util: {
        patientId: 'A',
        rationale:
            'Я выбираю A: выше вероятность выживания — максимизируем ожидаемую пользу при дефиците ресурса.',
        confidence: 0.74,
        changeTrigger:
            'Изменю позицию, если покажут, что чистая полезность здесь морально недопустима (например, игнорирует справедливость к худшему прогнозу).',
    },
    fair: {
        patientId: 'D',
        rationale:
            'Я выбираю D: меньше риска скрытой привилегии «знакомого врача» (B) и более ровное обоснование без статуса.',
        confidence: 0.61,
        changeTrigger: 'Изменю позицию, если докажут системный сдвиг критериев в пользу B только из профессиональной солидарности.',
    },
    duty: {
        patientId: 'C',
        rationale:
            'Я выбираю C: сильная защита уязвимого пациента; права ребёнка требуют особой процедурной осторожности.',
        confidence: 0.58,
        changeTrigger:
            'Изменю позицию, если комитет формально исключит возраст как допустимый тай-брейк без дискриминации.',
    },
    prag: {
        patientId: 'D',
        rationale:
            'Я выбираю D: решение проще публично объяснить как ориентированное на социальную уязвимость, без «тихих» статусных преимуществ.',
        confidence: 0.66,
        changeTrigger: 'Изменю позицию, если публика увидит в выборе D необоснованную дискриминацию по возрасту других пациентов.',
    },
});

export const fixtureCritiqueFairToUtil = (targetPositionMessageId: string): CritiqueMessage => ({
    targetMemberId: 'triage#utilitarian',
    targetPositionMessageId,
    objections: [
        'Ты переоцениваешь сырой прогноз выживаемости как единственный моральный факт.',
        'Так можно системно обделить пациентов с худшим стартовым прогнозом без отдельного обоснования.',
    ],
    alternativePatientId: 'D',
    alternativeReasoning:
        'D легче защищать как решение о социальной уязвимости, а не как скрытую привилегию статуса.',
});

export const fixtureCritiqueDutyToFair = (targetPositionMessageId: string): CritiqueMessage => ({
    targetMemberId: 'triage#fairness',
    targetPositionMessageId,
    objections: [
        'Ты избегаешь B, но используешь «роль врача» как красную тряпку без проверки допустимости критерия.',
        'Процедурно нужно явно сказать, учитывается ли профессиональный долг к коллеге как отдельное основание.',
    ],
    alternativePatientId: 'C',
    alternativeReasoning:
        'Если уязвимость — ключ, C требует отдельного процедурного обоснования, а не отсылки к «неравенству статуса».',
});

export const fixtureCritiquePragToUtil = (targetPositionMessageId: string): CritiqueMessage => ({
    targetMemberId: 'triage#utilitarian',
    targetPositionMessageId,
    objections: [
        'Публичная легитимность: «только число выживаемости» часто воспринимается как жёсткий утилитаризм без учёта доверия.',
    ],
    alternativePatientId: 'D',
    alternativeReasoning:
        'D даёт нарратив уязвимости, который гражданам проще принять в условиях дефицита.',
});

export const fixtureCritiqueReplyRu = {
    utilAfterFair:
        'Отвечаю на критику справедливости (см. сообщения указанные в ids): я усиливаю требование явного тай-брейка, но сохраняю вес прогноза как первичный.',
    fairAfterDuty:
        'Принимаю процедурный укор: про B нужен явный критерий, а не автоматическое исключение по роли.',
    utilAfterPrag:
        'Согласен добавить требование публичной аргументации; это не отменяет прогноз, но меняет форму презентации решения.',
};

export const fixtureRevisionBySeat = (refs: {
    util: string[];
    fair: string[];
    duty: string[];
    prag: string[];
}): { util: RevisionMessage; fair: RevisionMessage; duty: RevisionMessage; prag: RevisionMessage } => ({
    util: {
        patientId: 'A',
        changedMind: false,
        rationale:
            'После обмена я остаюсь у A, но признаю необходимость явной процедуры для слабых прогнозов (ответ на реплики панели).',
        confidence: 0.7,
        respondsToMessageIds: refs.util,
    },
    fair: {
        patientId: 'D',
        changedMind: false,
        rationale:
            'Уточняю: мой акцент на D держится на публичной защите без статусной привилегии; процедурные ноты duty учтены формально.',
        confidence: 0.64,
        respondsToMessageIds: refs.fair,
    },
    duty: {
        patientId: 'D',
        changedMind: true,
        rationale:
            'Меняю выбор с C на D: синтез показал, что отсутствие явного большинства по C делает решение процедурно хрупким; D даёт более устойчивое обоснование уязвимости.',
        confidence: 0.62,
        respondsToMessageIds: refs.duty,
    },
    prag: {
        patientId: 'D',
        changedMind: false,
        rationale:
            'Укрепляю D как наиболее объяснимый для доверия при дефиците; дополнительные оговорки для B остаются в протоколе.',
        confidence: 0.68,
        respondsToMessageIds: refs.prag,
    },
});

export const fixtureFinalDecision: FinalDecision = {
    selectedPatientId: 'D',
    summary:
        'Рабочее решение панели: D как компромисс между публичной объяснимостью и защитой уязвимости; A и B остаются спорными по осям утилитаризм и статус.',
    rejectedAlternatives: [
        { patientId: 'A', whyNotSelected: 'Высокий прогноз не перевешивает коллективные опасения по справедливости и доверию в этом составе.' },
        { patientId: 'B', whyNotSelected: 'Риск восприятия профессиональной привилегии без отдельного процедурного критерия.' },
        { patientId: 'C', whyNotSelected: 'Низкая согласованность и процедурная хрупкость при отсутствии явного большинства.' },
    ],
    consensusLevel: 'medium',
};

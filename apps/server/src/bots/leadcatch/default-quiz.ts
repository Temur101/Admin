import type { QuizConfig } from "@lcqb/contracts";

export const DEFAULT_LEADCATCH_QUIZ: QuizConfig = {
  startNodeId: "q1_service",
  nodes: [
    {
      id: "q1_service",
      title: {
        ru: "Какая услуга вас интересует?",
        uz: "Sizni qaysi xizmat qiziqtiradi?",
      },
      options: [
        {
          id: "opt_consult",
          text: {
            ru: "💡 Консультация специалиста",
            uz: "💡 Mutaxassis maslahati",
          },
          nextNodeId: "q2_time",
        },
        {
          id: "opt_project",
          text: {
            ru: "🚀 Запуск проекта под ключ",
            uz: "🚀 Loyihani to'liq ishga tushirish",
          },
          nextNodeId: "q2_time",
        },
        {
          id: "opt_audit",
          text: {
            ru: "🔍 Анализ и аудит",
            uz: "🔍 Tahlil va audit",
          },
          nextNodeId: "q2_time",
        },
      ],
    },
    {
      id: "q2_time",
      title: {
        ru: "Когда вам удобно обсудить детали?",
        uz: "Tafsilotlarni qachon muhokama qilish qulay?",
      },
      options: [
        {
          id: "opt_asap",
          text: {
            ru: "⚡️ Как можно скорее",
            uz: "⚡️ Imkon qadar tezroq",
          },
          nextNodeId: "q3_budget",
        },
        {
          id: "opt_morning",
          text: {
            ru: "☀️ В первой половине дня",
            uz: "☀️ Kunning birinchi yarmida",
          },
          nextNodeId: "q3_budget",
        },
        {
          id: "opt_evening",
          text: {
            ru: "🌙 Вечером",
            uz: "🌙 Kechqurun",
          },
          nextNodeId: "q3_budget",
        },
      ],
    },
    {
      id: "q3_budget",
      title: {
        ru: "Укажите ориентировочный бюджет:",
        uz: "Mo'ljallangan byudjetingizni tanlang:",
      },
      options: [
        {
          id: "opt_budget_base",
          text: {
            ru: "Базовый",
            uz: "Boshlang'ich",
          },
          nextNodeId: null,
        },
        {
          id: "opt_budget_standard",
          text: {
            ru: "Стандартный",
            uz: "Standart",
          },
          nextNodeId: null,
        },
        {
          id: "opt_budget_pro",
          text: {
            ru: "Премиум / Индивидуальный",
            uz: "Premium / Shaxsiy",
          },
          nextNodeId: null,
        },
      ],
    },
  ],
};

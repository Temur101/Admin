import type { QuizConfig } from "@lcqb/contracts";

export interface LeadCatchTemplateMeta {
  id: string;
  name: string;
  description: string;
  botType: "LEADCATCH";
  config: QuizConfig;
}

export const LEADCATCH_TEMPLATES: LeadCatchTemplateMeta[] = [
  {
    id: "education_center",
    name: "Учебный центр (Пилот А)",
    description: "Сбор заявок на курсы (языки, программирование), определение уровня и контактов",
    botType: "LEADCATCH",
    config: {
      startNodeId: "q1_subject",
      nodes: [
        {
          id: "q1_subject",
          title: {
            ru: "Какое направление вас интересует?",
            uz: "Qaysi yo'nalish sizni qiziqtiradi?",
          },
          options: [
            {
              id: "opt_it",
              text: { ru: "💻 Программирование / IT", uz: "💻 Dasturlash / IT" },
              nextNodeId: "q2_level",
            },
            {
              id: "opt_lang",
              text: { ru: "🇬🇧 Английский язык", uz: "🇬🇧 Ingliz tili" },
              nextNodeId: "q2_level",
            },
            {
              id: "opt_math",
              text: { ru: "📐 Точные науки / ЕГЭ", uz: "📐 Aniq fanlar" },
              nextNodeId: "q2_level",
            },
          ],
        },
        {
          id: "q2_level",
          title: {
            ru: "Ваш текущий уровень знаний?",
            uz: "Hozirgi bilim darajangiz qanday?",
          },
          options: [
            {
              id: "opt_beginner",
              text: { ru: "🌱 Начинающий (с нуля)", uz: "🌱 Boshlang'ich (noldan)" },
              nextNodeId: "q3_schedule",
            },
            {
              id: "opt_middle",
              text: { ru: "⚡️ Есть базовые знания", uz: "⚡️ Boshlang'ich bilimlar bor" },
              nextNodeId: "q3_schedule",
            },
          ],
        },
        {
          id: "q3_schedule",
          title: {
            ru: "В какое время вам удобно учиться?",
            uz: "Qaysi vaqtda o'qish qulay?",
          },
          options: [
            {
              id: "opt_morning",
              text: { ru: "☀️ Утро (09:00 - 13:00)", uz: "☀️ Ertalab (09:00 - 13:00)" },
              nextNodeId: "q4_goal",
            },
            {
              id: "opt_evening",
              text: { ru: "🌙 Вечер (18:00 - 21:00)", uz: "🌙 Kechki payt (18:00 - 21:00)" },
              nextNodeId: "q4_goal",
            },
          ],
        },
        {
          id: "q4_goal",
          title: {
            ru: "Ваша главная цель обучения?",
            uz: "O'qishdan asosiy maqsadingiz?",
          },
          options: [
            {
              id: "opt_job",
              text: { ru: "💼 Трудоустройство / Карьера", uz: "💼 Ishga joylashish" },
              nextNodeId: "q5_phone",
            },
            {
              id: "opt_hobby",
              text: { ru: "🎨 Для себя / Хобби", uz: "🎨 O'zim uchun / Xobbi" },
              nextNodeId: "q5_phone",
            },
          ],
        },
        {
          id: "q5_phone",
          title: {
            ru: "Оставьте контактный номер для связи с куратором:",
            uz: "Kurator siz bilan bog'lanishi uchun telefon raqamingizni qoldiring:",
          },
          options: [
            {
              id: "opt_phone_finish",
              text: { ru: "📱 Отправить заявку", uz: "📱 Ariza yuborish" },
              nextNodeId: null,
            },
          ],
        },
      ],
    },
  },
  {
    id: "fitness_club",
    name: "Фитнес-клуб / Тренажерный зал",
    description: "Анкетирование новых клиентов на персональные или групповые тренировки",
    botType: "LEADCATCH",
    config: {
      startNodeId: "fit_goal",
      nodes: [
        {
          id: "fit_goal",
          title: { ru: "Какова ваша основная цель?", uz: "Asosiy maqsadingiz nima?" },
          options: [
            {
              id: "fg_weight_loss",
              text: { ru: "🏃 Похудение и рельеф", uz: "🏃 Ozish va qomat" },
              nextNodeId: "fit_exp",
            },
            {
              id: "fg_muscle",
              text: { ru: "💪 Набор мышечной массы", uz: "💪 Mushak massasini oshirish" },
              nextNodeId: "fit_exp",
            },
            {
              id: "fg_health",
              text: { ru: "🧘 Здоровье и тонус", uz: "🧘 Salomatlik va tonus" },
              nextNodeId: "fit_exp",
            },
          ],
        },
        {
          id: "fit_exp",
          title: {
            ru: "Занимались ли вы фитнесом ранее?",
            uz: "Oldin fitnes bilan shug'ullanganmisiz?",
          },
          options: [
            {
              id: "fe_no",
              text: { ru: "Впервые в зале", uz: "Birinchi marta zalda" },
              nextNodeId: "fit_phone",
            },
            {
              id: "fe_yes",
              text: { ru: "Есть опыт тренировок", uz: "Mashg'ulot tajribasi bor" },
              nextNodeId: "fit_phone",
            },
          ],
        },
        {
          id: "fit_phone",
          title: {
            ru: "Оставьте телефон для записи на бесплатную ознакомительную тренировку:",
            uz: "Bepul sinov mashg'ulotiga yozilish uchun telefoningizni qoldiring:",
          },
          options: [
            {
              id: "fit_phone_finish",
              text: { ru: "📱 Записаться на пробное", uz: "📱 Mashg'ulotga yozilish" },
              nextNodeId: null,
            },
          ],
        },
      ],
    },
  },
  {
    id: "real_estate",
    name: "Агентство недвижимости",
    description: "Сбор критериев поиска жилья (покупка / аренда, бюджет, районы)",
    botType: "LEADCATCH",
    config: {
      startNodeId: "re_type",
      nodes: [
        {
          id: "re_type",
          title: { ru: "Что вас интересует?", uz: "Sizni nima qiziqtiradi?" },
          options: [
            {
              id: "rt_buy",
              text: { ru: "🏢 Покупка квартиры", uz: "🏢 Kvartira sotib olish" },
              nextNodeId: "re_rooms",
            },
            {
              id: "rt_rent",
              text: { ru: "🔑 Аренда жилья", uz: "🔑 Kvartira ijarasi" },
              nextNodeId: "re_rooms",
            },
          ],
        },
        {
          id: "re_rooms",
          title: { ru: "Количество комнат:", uz: "Xonalar soni:" },
          options: [
            {
              id: "rr_1",
              text: { ru: "1-комнатная / Студия", uz: "1 xonali / Studiya" },
              nextNodeId: "re_phone",
            },
            {
              id: "rr_2",
              text: { ru: "2-комнатная", uz: "2 xonali" },
              nextNodeId: "re_phone",
            },
            {
              id: "rr_3",
              text: { ru: "3+ комнатная", uz: "3+ xonali" },
              nextNodeId: "re_phone",
            },
          ],
        },
        {
          id: "re_phone",
          title: {
            ru: "Укажите контактный номер для отправки подходящих вариантов в Telegram/WhatsApp:",
            uz: "Mos variantlarni yuborish uchun telefon raqamingizni qoldiring:",
          },
          options: [
            {
              id: "re_phone_finish",
              text: { ru: "📱 Получить варианты", uz: "📱 Variantlarni olish" },
              nextNodeId: null,
            },
          ],
        },
      ],
    },
  },
];

import type { QuickBookConfig } from "@lcqb/contracts";

export interface QuickBookTemplateMeta {
  id: string;
  name: string;
  description: string;
  botType: "QUICKBOOK";
  config: QuickBookConfig;
}

export const QUICKBOOK_TEMPLATES: QuickBookTemplateMeta[] = [
  {
    id: "barbershop_2masters",
    name: "Барбершоп — 2 мастера",
    description: "Онлайн-запись к 2 топ-мастерам на стрижки и уход за бородой",
    botType: "QUICKBOOK",
    config: {
      resourceType: "STAFF",
      services: [
        {
          id: "srv_haircut",
          name: { ru: "Стрижка мужская классическая", uz: "Klassik erkaklar sochi" },
          durationMin: 45,
          priceUzs: 80_000,
        },
        {
          id: "beard_trim",
          name: { ru: "Моделирование и стрижка бороды", uz: "Soqol modelirovka qilish" },
          durationMin: 30,
          priceUzs: 50_000,
        },
        {
          id: "combo_hair_beard",
          name: { ru: "Комплекс (Стрижка + Борода)", uz: "Kompleks (Soch + Soqol)" },
          durationMin: 60,
          priceUzs: 110_000,
        },
      ],
      resources: [
        {
          id: "master_alisher",
          name: { ru: "Алишер (Топ-барбер)", uz: "Alisher (Top-barber)" },
          workDays: [0, 1, 2, 3, 4, 5, 6],
          workHours: { start: "10:00", end: "20:00" },
        },
        {
          id: "master_aziz",
          name: { ru: "Азиз (Барбер)", uz: "Aziz (Barber)" },
          workDays: [0, 1, 2, 3, 4, 5, 6],
          workHours: { start: "11:00", end: "21:00" },
        },
      ],
      slotIntervalMin: 30,
      bookingHorizonDays: 14,
      timezone: "Asia/Tashkent",
    },
  },
  {
    id: "beauty_salon",
    name: "Салон красоты / Маникюр",
    description: "Онлайн-запись на маникюр, педикюр и уход за волосами",
    botType: "QUICKBOOK",
    config: {
      resourceType: "STAFF",
      services: [
        {
          id: "manicure_gel",
          name: { ru: "Маникюр + Гель-лак", uz: "Manikyur + Gel-lak" },
          durationMin: 90,
          priceUzs: 120_000,
        },
        {
          id: "pedicure",
          name: { ru: "Педикюр классический", uz: "Klassik pedikyur" },
          durationMin: 60,
          priceUzs: 100_000,
        },
        {
          id: "eyebrows",
          name: { ru: "Оформление бровей", uz: "Qosh bo'yash va terish" },
          durationMin: 30,
          priceUzs: 40_000,
        },
      ],
      resources: [
        {
          id: "master_malika",
          name: { ru: "Малика (Мастер ногтевого сервиса)", uz: "Malika (Tirnoq ustasi)" },
          workDays: [1, 2, 3, 4, 5],
          workHours: { start: "09:00", end: "18:00" },
        },
        {
          id: "master_dilnoza",
          name: { ru: "Дильноза (Бровист / Мастер)", uz: "Dilnoza (Qosh ustasi)" },
          workDays: [2, 3, 4, 5, 6],
          workHours: { start: "10:00", end: "19:00" },
        },
      ],
      slotIntervalMin: 30,
      bookingHorizonDays: 14,
      timezone: "Asia/Tashkent",
    },
  },
  {
    id: "dentistry_consultation",
    name: "Стоматологическая клиника",
    description: "Запись на первичную консультацию и диагностику к врачу-стоматологу",
    botType: "QUICKBOOK",
    config: {
      resourceType: "STAFF",
      services: [
        {
          id: "dent_consult",
          name: { ru: "Первичный осмотр и консультация", uz: "Birlamchi ko'rik va konsultatsiya" },
          durationMin: 30,
          priceUzs: 50_000,
        },
        {
          id: "dent_clean",
          name: { ru: "Ультразвуковая чистка зубов", uz: "Ultratovushli tish tozalash" },
          durationMin: 60,
          priceUzs: 250_000,
        },
      ],
      resources: [
        {
          id: "dr_alim",
          name: { ru: "Д-р Алим (Стоматолог-терапевт)", uz: "Dr. Alim (Stomatolog-terapevt)" },
          workDays: [1, 2, 3, 4, 5, 6],
          workHours: { start: "09:00", end: "17:00" },
        },
      ],
      slotIntervalMin: 30,
      bookingHorizonDays: 14,
      timezone: "Asia/Tashkent",
    },
  },
  {
    id: "restaurant_tables",
    name: "Ресторан / Бронь столиков",
    description: "Резерв столов в зале, на террасе и в VIP-зале",
    botType: "QUICKBOOK",
    config: {
      resourceType: "TABLE",
      resourceLabel: { ru: "Зона ресторана", uz: "Restoran zonasi" },
      services: [
        {
          id: "srv_lunch",
          name: { ru: "Обед / Ланч (1.5 часа)", uz: "Tushlik (1.5 soat)" },
          durationMin: 90,
          priceUzs: 0,
        },
        {
          id: "srv_dinner",
          name: { ru: "Ужин (2 часа)", uz: "Kechki ovqat (2 soat)" },
          durationMin: 120,
          priceUzs: 0,
        },
      ],
      resources: [
        {
          id: "table_hall",
          name: { ru: "Столик в основном зале", uz: "Asosiy zal stoli" },
          workDays: [0, 1, 2, 3, 4, 5, 6],
          workHours: { start: "12:00", end: "23:00" },
        },
        {
          id: "table_terrace",
          name: { ru: "Столик на летней террасе", uz: "Yozgi terassa stoli" },
          workDays: [0, 1, 2, 3, 4, 5, 6],
          workHours: { start: "12:00", end: "23:00" },
        },
        {
          id: "table_vip",
          name: { ru: "VIP комната (до 10 чел)", uz: "VIP xona (10 kishigacha)" },
          workDays: [0, 1, 2, 3, 4, 5, 6],
          workHours: { start: "12:00", end: "23:00" },
        },
      ],
      slotIntervalMin: 60,
      bookingHorizonDays: 7,
      timezone: "Asia/Tashkent",
    },
  },
];

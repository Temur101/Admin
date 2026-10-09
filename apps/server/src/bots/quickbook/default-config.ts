import type { QuickBookConfig } from "@lcqb/contracts";

export const DEFAULT_QUICKBOOK_CONFIG: QuickBookConfig = {
  resourceType: "STAFF",
  resourceLabel: {
    ru: "Мастер",
    uz: "Usta",
  },
  services: [
    {
      id: "srv_haircut",
      name: {
        ru: "Мужская стрижка",
        uz: "Erkaklar soch turmagi",
      },
      description: {
        ru: "Мытье головы, стрижка, укладка",
        uz: "Bosh yuvish, soch olish, turmaklash",
      },
      durationMin: 45,
      priceUzs: 100000,
    },
    {
      id: "srv_beard",
      name: {
        ru: "Стрижка бороды",
        uz: "Soqol turmagi",
      },
      description: {
        ru: "Моделирование бороды и усов",
        uz: "Soqol va mo'ylovni tekislash",
      },
      durationMin: 30,
      priceUzs: 50000,
    },
    {
      id: "srv_combo",
      name: {
        ru: "Комплекс (Стрижка + Борода)",
        uz: "Kompleks (Soch + Soqol)",
      },
      description: {
        ru: "Полный комплекс ухода за волосами и бородой",
        uz: "Soch va soqolni to'liq tartibga keltirish",
      },
      durationMin: 60,
      priceUzs: 130000,
    },
  ],
  resources: [
    {
      id: "staff_alisher",
      name: {
        ru: "Алишер",
        uz: "Alisher",
      },
      workDays: [1, 2, 3, 4, 5, 6], // Пн - Сб
      workHours: {
        start: "10:00",
        end: "20:00",
      },
      breakHours: {
        start: "14:00",
        end: "15:00",
      },
    },
    {
      id: "staff_jasur",
      name: {
        ru: "Жасур",
        uz: "Jasur",
      },
      workDays: [2, 3, 4, 5, 6, 0], // Вт - Вс
      workHours: {
        start: "09:00",
        end: "19:00",
      },
      breakHours: {
        start: "13:00",
        end: "14:00",
      },
    },
  ],
  slotIntervalMin: 30,
  bookingHorizonDays: 14,
  timezone: "Asia/Tashkent",
};

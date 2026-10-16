import type { ResourceType } from "@lcqb/contracts";

export const resourceWording: Record<
  ResourceType,
  { title: string; add: string; remove: string; placeholder: string; hours: string }
> = {
  STAFF: {
    title: "Сотрудники",
    add: "Добавить сотрудника",
    remove: "Удалить сотрудника",
    placeholder: "Имя сотрудника",
    hours: "Часы работы",
  },
  TABLE: {
    title: "Столы",
    add: "Добавить стол",
    remove: "Удалить стол",
    placeholder: "Название стола",
    hours: "Часы бронирования",
  },
  ROOM: {
    title: "Помещения",
    add: "Добавить помещение",
    remove: "Удалить помещение",
    placeholder: "Название помещения",
    hours: "Часы бронирования",
  },
};

import type { Bot } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";

export function registerLeadCatchBot(bot: Bot<PlatformBotContext>): void {
  bot.command("start", async (ctx) => {
    await ctx.reply("LeadCatch Bot ready.");
  });
}

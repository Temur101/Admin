import React, { useState } from "react";
import { RotateCcw, Bot as BotIcon, CheckCircle2 } from "lucide-react";
import type { QuizNode } from "@lcqb/contracts";

interface QuizFlowPreviewProps {
  nodes: QuizNode[];
  startNodeId: string;
}

export function QuizFlowPreview({ nodes, startNodeId }: QuizFlowPreviewProps) {
  const [activeNodeId, setActiveNodeId] = useState<string | null>(startNodeId);
  const [isFinished, setIsFinished] = useState(false);
  const [lang, setLang] = useState<"ru" | "uz">("ru");

  const currentNode = nodes.find((n) => n.id === (activeNodeId ?? startNodeId));

  const handleOptionClick = (nextNodeId?: string | null) => {
    if (nextNodeId && nodes.some((n) => n.id === nextNodeId)) {
      setActiveNodeId(nextNodeId);
      setIsFinished(false);
    } else {
      setIsFinished(true);
    }
  };

  const handleReset = () => {
    setActiveNodeId(startNodeId);
    setIsFinished(false);
  };

  return (
    <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-full bg-sky-500/20 text-sky-400 flex items-center justify-center">
            <BotIcon className="h-3.5 w-3.5" />
          </div>
          <div>
            <p className="text-xs font-semibold text-white">Превью диалога Telegram</p>
            <p className="text-[10px] text-slate-500">Симуляция взаимодействия с пользователем</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setLang("ru")}
              className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                lang === "ru" ? "bg-indigo-600 text-white font-medium" : "text-slate-400 hover:text-white"
              }`}
            >
              RU
            </button>
            <button
              type="button"
              onClick={() => setLang("uz")}
              className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                lang === "uz" ? "bg-indigo-600 text-white font-medium" : "text-slate-400 hover:text-white"
              }`}
            >
              UZ
            </button>
          </div>

          <button
            type="button"
            onClick={handleReset}
            title="Перезапустить превью"
            className="p-1.5 rounded-lg border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-900 transition-colors cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Окно диалога Telegram */}
      <div className="bg-slate-900/90 rounded-xl p-3 border border-slate-800/80 space-y-3 min-h-[140px] flex flex-col justify-center">
        {isFinished ? (
          <div className="text-center py-4 space-y-2">
            <div className="h-10 w-10 mx-auto rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <p className="text-xs font-semibold text-emerald-400">
              {lang === "ru" ? "Опрос успешно завершен!" : "So'rovnoma yakunlandi!"}
            </p>
            <p className="text-[11px] text-slate-400 max-w-[260px] mx-auto">
              {lang === "ru"
                ? "Бот запросит контакт пользователя (номер телефона) и создаст заявку в CRM."
                : "Bot foydalanuvchining telefon raqamini so'raydi va tizimda arizani yaratadi."}
            </p>
            <button
              type="button"
              onClick={handleReset}
              className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
            >
              Пройти снова
            </button>
          </div>
        ) : currentNode ? (
          <div className="space-y-2.5 max-w-[340px]">
            <div className="p-3 bg-slate-800/90 rounded-2xl rounded-tl-xs text-xs text-slate-100 shadow-sm border border-slate-700/50">
              {currentNode.title[lang] || "(Текст вопроса отсутствует)"}
            </div>

            <div className="space-y-1.5">
              {currentNode.options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleOptionClick(opt.nextNodeId)}
                  className="w-full text-left px-3 py-2 bg-slate-800/60 hover:bg-indigo-600/30 hover:border-indigo-500/50 border border-slate-700/60 rounded-xl text-xs text-slate-200 transition-colors cursor-pointer flex items-center justify-between"
                >
                  <span className="truncate">{opt.text[lang] || opt.id}</span>
                  <span className="text-[10px] text-slate-500 font-mono ml-2 shrink-0">
                    {opt.nextNodeId ? "→" : "🏁"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-center text-slate-500">
            Вопрос не найден. Выберите стартовый узел.
          </p>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import {
  QuizFreeTextAnswerSchema,
  QUIZ_FREE_TEXT_MAX_LENGTH,
  type QuizNode,
  type QuizOption,
} from "@lcqb/contracts";
import { Textarea } from "../../common/Input.js";
import { Button } from "../../common/Button.js";
export function QuizFlowPreview({
  nodes,
  startNodeId,
}: {
  nodes: QuizNode[];
  startNodeId: string;
}) {
  const [activeId, setActiveId] = useState(startNodeId);
  const [path, setPath] = useState<string[]>([startNodeId]);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<"ru" | "uz">("ru");
  const [pendingText, setPendingText] = useState<QuizOption | null>(null);
  const [text, setText] = useState("");
  const [textError, setTextError] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<string | null>(null);
  const current = nodes.find((node) => node.id === activeId);
  const reset = () => {
    setActiveId(startNodeId);
    setPath([startNodeId]);
    setFinished(false);
    setError(null);
    setPendingText(null);
    setText("");
    setTextError(false);
    setLastAnswer(null);
  };
  const answer = (nextId?: string | null) => {
    if (!nextId) {
      setFinished(true);
      return;
    }
    if (!nodes.some((node) => node.id === nextId)) {
      setError("Этот ответ ведёт на удалённый вопрос. Исправьте переход.");
      return;
    }
    if (path.includes(nextId)) {
      setError("Найден круговой переход. Клиент уже отвечал на этот вопрос — исправьте переход.");
      return;
    }
    setPath([...path, nextId]);
    setActiveId(nextId);
  };
  const submitText = () => {
    const parsed = QuizFreeTextAnswerSchema.safeParse(text);
    if (!parsed.success || !pendingText) {
      setTextError(true);
      return;
    }
    setLastAnswer(parsed.data);
    answer(pendingText.nextNodeId);
    setPendingText(null);
    setText("");
    setTextError(false);
  };
  return (
    <section
      aria-label="Предпросмотр диалога"
      className="rounded-2xl border border-ui-border bg-ui-subtle p-4 space-y-4"
    >
      <h4 className="font-semibold">Предпросмотр диалога</h4>
      <p className="text-sm text-ui-muted">
        Нажимайте ответы, как клиент. Контакт не отправляется, заявка не создаётся. После изменения
        вопросов предпросмотр начинается заново.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {(["ru", "uz"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={lang === value}
            onClick={() => setLang(value)}
            className={`rounded-lg border px-3 py-2 text-sm ${lang === value ? "bg-ui-accent text-ui-on-accent border-ui-accent" : "bg-ui-surface border-ui-border"}`}
          >
            {value.toUpperCase()}
          </button>
        ))}
        <Button size="sm" variant="outline" onClick={reset}>
          Начать заново
        </Button>
      </div>
      <div
        className="p-4 rounded-xl border border-ui-border bg-ui-surface space-y-3"
        aria-live="polite"
      >
        {lastAnswer && (
          <p className="rounded-xl bg-ui-accent-soft p-3 whitespace-pre-wrap break-words">
            {lastAnswer}
          </p>
        )}
        {error ? (
          <p className="text-sm text-ui-danger">{error}</p>
        ) : finished ? (
          <>
            <p className="font-medium text-ui-success">
              {lang === "ru" ? "Следующий шаг — контакт клиента" : "Keyingi qadam — mijoz telefoni"}
            </p>
            <p className="text-sm text-ui-secondary">
              {lang === "ru"
                ? "Бот попросит поделиться номером телефона и сохранит заявку."
                : "Bot telefon raqamini so‘raydi va arizani saqlaydi."}
            </p>
            <p
              className={`text-sm ${path.length >= 3 && path.length <= 5 ? "text-ui-muted" : "text-ui-warning"}`}
            >
              Пройдено вопросов: {path.length}. Для запуска нужно 3–5.
            </p>
          </>
        ) : current ? (
          <>
            <p className="text-xs text-ui-muted">Вопрос {path.length} в этом диалоге</p>
            <p className="rounded-xl bg-ui-subtle p-3 break-words">
              {current.title[lang] || "Заполните текст вопроса"}
            </p>
            {pendingText ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  submitText();
                }}
                className="space-y-3"
              >
                <p className="text-sm text-ui-secondary">{pendingText.text[lang]}</p>
                <Textarea
                  label={lang === "ru" ? "Ваш ответ" : "Javobingiz"}
                  value={text}
                  maxLength={QUIZ_FREE_TEXT_MAX_LENGTH}
                  onChange={(event) => {
                    setText(event.target.value);
                    setTextError(false);
                  }}
                  error={
                    textError
                      ? lang === "ru"
                        ? `Введите от 1 до ${QUIZ_FREE_TEXT_MAX_LENGTH} символов.`
                        : `1 dan ${QUIZ_FREE_TEXT_MAX_LENGTH} gacha belgi kiriting.`
                      : undefined
                  }
                />
                <Button type="submit" size="sm">
                  {lang === "ru" ? "Отправить ответ" : "Javobni yuborish"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPendingText(null);
                    setText("");
                    setTextError(false);
                  }}
                >
                  {lang === "ru" ? "Вернуться к вариантам" : "Variantlarga qaytish"}
                </Button>
              </form>
            ) : (
              current.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() =>
                    option.inputType === "TEXT" ? setPendingText(option) : answer(option.nextNodeId)
                  }
                  className="block w-full text-left rounded-xl border border-ui-border bg-ui-subtle hover:bg-ui-accent-soft p-3 text-sm break-words"
                >
                  {option.text[lang] || "Заполните ответ"}
                </button>
              ))
            )}
          </>
        ) : (
          <p className="text-sm text-ui-muted">
            Добавьте вопросы и выберите первый вопрос кнопкой «Сделать стартом».
          </p>
        )}
      </div>
    </section>
  );
}

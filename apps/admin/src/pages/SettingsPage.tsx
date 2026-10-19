import { DEFAULT_TARIFFS, normalizeTariffs } from "@lcqb/contracts/tariffs";
import { useUnsavedChanges } from "../context/UnsavedChangesContext.js";
import { ApiErrorAlert } from "../components/common/ApiErrorAlert.js";
import type { UpdatePlatformSettingsRequest } from "@lcqb/contracts";
import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Bell, CreditCard, ShieldAlert, Sparkles, Send } from "lucide-react";
import { getPlatformSettings, updatePlatformSettings, sendTestAlert } from "../api/settings.js";
import { Button } from "../components/common/Button.js";
import { Input } from "../components/common/Input.js";
import { Alert } from "../components/common/Alert.js";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [hydrated, setHydrated] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [paymentDetails, setPaymentDetails] = useState("");
  const [supportContact, setSupportContact] = useState("");
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [alertChatId, setAlertChatId] = useState("");
  const [tariff1m, setTariff1m] = useState(DEFAULT_TARIFFS[0]!.amountUzs);
  const [tariff6m, setTariff6m] = useState(DEFAULT_TARIFFS[1]!.amountUzs);
  const [tariff12m, setTariff12m] = useState(DEFAULT_TARIFFS[2]!.amountUzs);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const {
    data: settings,
    isLoading,
    error: settingsError,
  } = useQuery({
    queryKey: ["platform-settings"],
    queryFn: getPlatformSettings,
  });

  const payload: UpdatePlatformSettingsRequest = {
    paymentDetails,
    supportContact,
    maintenanceMode,
    alertChatId: alertChatId.trim() || undefined,
    tariffs: [
      { months: 1, amountUzs: Number(tariff1m) },
      { months: 6, amountUzs: Number(tariff6m) },
      { months: 12, amountUzs: Number(tariff12m) },
    ],
  };
  const dirty = hydrated && JSON.stringify(payload) !== savedSnapshot;
  useUnsavedChanges("platform-settings", dirty);

  useEffect(() => {
    if (!settings || hydrated) return;
    const tariffs = normalizeTariffs(settings.tariffs);
    const amount = (months: number) =>
      tariffs.find((tariff) => tariff.months === months)!.amountUzs;
    const initial = {
      paymentDetails: settings.paymentDetails || "",
      supportContact: settings.supportContact || "",
      maintenanceMode: settings.maintenanceMode ?? false,
      alertChatId: settings.alertChatId?.trim() || undefined,
      tariffs,
    };
    setPaymentDetails(initial.paymentDetails);
    setSupportContact(initial.supportContact);
    setMaintenanceMode(initial.maintenanceMode);
    setAlertChatId(initial.alertChatId ?? "");
    setTariff1m(amount(1));
    setTariff6m(amount(6));
    setTariff12m(amount(12));
    setSavedSnapshot(JSON.stringify(initial));
    setHydrated(true);
  }, [settings, hydrated]);

  const saveMut = useMutation({
    mutationFn: (submitted: UpdatePlatformSettingsRequest) => updatePlatformSettings(submitted),
    onSuccess: (_settings, submitted) => {
      setSavedSnapshot(JSON.stringify(submitted));
      void queryClient.invalidateQueries({ queryKey: ["platform-settings"] });
      setFeedback("Настройки платформы успешно сохранены.");
      setErrorMsg(null);
    },
    onError: () => {
      setErrorMsg(null);
      setFeedback(null);
    },
  });

  const testAlertMut = useMutation({
    mutationFn: sendTestAlert,
    onSuccess: () => {
      setFeedback("Тестовое уведомление успешно отправлено в Telegram Alert Bot!");
      setErrorMsg(null);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || "Не удалось отправить тестовый алерт");
      setFeedback(null);
    },
  });

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveMut.mutate(payload);
  };

  if (isLoading) {
    return <div className="p-8 text-center text-ui-muted text-sm">Загрузка настроек...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-ui-text tracking-tight">Настройки платформы</h1>
        <p className="text-sm text-ui-muted mt-1">
          Глобальные параметры оплат, реквизиты, оповещения владельца и тарифная сетка
        </p>
      </div>

      <ApiErrorAlert error={settingsError || saveMut.error} />
      {dirty && (
        <Alert type="warning" title="Есть несохранённые изменения">
          Сохраните настройки перед выходом.
        </Alert>
      )}
      {feedback && !dirty && (
        <Alert type="success" title="Успех">
          {feedback}
        </Alert>
      )}

      {errorMsg && (
        <Alert type="error" title="Ошибка">
          {errorMsg}
        </Alert>
      )}

      <form onSubmit={handleSave}>
        <fieldset disabled={saveMut.isPending || !hydrated} className="space-y-6 min-w-0">
          {/* Реквизиты и оплата */}
          <div className="p-6 bg-ui-surface border border-ui-border rounded-2xl space-y-4">
            <h3 className="text-sm font-semibold text-ui-text flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-ui-accent" />
              <span>Платёжные реквизиты для продления</span>
            </h3>

            <Input
              label="Номер карты и получатель (отображается админам ботов)"
              placeholder="8600 0000 0000 0000 (Uzcard) / Имя Получателя"
              value={paymentDetails}
              onChange={(e) => setPaymentDetails(e.target.value)}
              required
            />

            <Input
              label="Контакт технической поддержки (@username или телефон)"
              placeholder="@pilot_support"
              value={supportContact}
              onChange={(e) => setSupportContact(e.target.value)}
              required
            />
          </div>

          {/* Тарифная сетка */}
          <div className="p-6 bg-ui-surface border border-ui-border rounded-2xl space-y-4">
            <h3 className="text-sm font-semibold text-ui-text flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-ui-accent" />
              <span>Тарифная сетка подписок (UZS)</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                label="1 месяц (UZS)"
                type="number"
                value={tariff1m}
                onChange={(e) => setTariff1m(Number(e.target.value))}
                required
              />
              <Input
                label="6 месяцев (UZS)"
                type="number"
                value={tariff6m}
                onChange={(e) => setTariff6m(Number(e.target.value))}
                required
              />
              <Input
                label="12 месяцев (UZS)"
                type="number"
                value={tariff12m}
                onChange={(e) => setTariff12m(Number(e.target.value))}
                required
              />
            </div>
          </div>

          {/* Telegram Alert Bot */}
          <div className="p-6 bg-ui-surface border border-ui-border rounded-2xl space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ui-text flex items-center gap-2">
                <Bell className="h-4 w-4 text-ui-warning" />
                <span>Platform Alert Bot (Уведомления владельца SaaS)</span>
              </h3>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => testAlertMut.mutate()}
                isLoading={testAlertMut.isPending}
                icon={<Send className="h-3.5 w-3.5" />}
              >
                Тестовое уведомление
              </Button>
            </div>

            <p className="text-sm text-ui-muted leading-relaxed">
              Отправляет мгновенные оповещения о новых поданных чеках, регистрации ботов и
              блокировках.
            </p>

            <Input
              label="ID чата владельца платформы (alertChatId)"
              placeholder="Например: 123456789"
              value={alertChatId}
              onChange={(e) => setAlertChatId(e.target.value)}
            />
          </div>

          {/* Технический перерыв */}
          <div className="p-6 bg-ui-surface border border-ui-border rounded-2xl flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-ui-text flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-ui-danger" />
                <span>Режим технического перерыва (Maintenance Mode)</span>
              </h3>
              <p className="text-sm text-ui-muted">
                Временно приостанавливает диалоги в клиентских ботах с уведомлением о технических
                работах. Включается после сохранения настроек; управление владельца и отмена
                существующих записей остаются доступны.
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                aria-label="Режим технического перерыва"
                checked={maintenanceMode}
                onChange={(e) => setMaintenanceMode(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-ui-hover peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-ui-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-ui-danger"></div>
            </label>
          </div>

          <div className="flex justify-end pt-2">
            <Button
              variant="primary"
              size="lg"
              type="submit"
              isLoading={saveMut.isPending}
              icon={<Save className="h-4 w-4" />}
            >
              Сохранить настройки
            </Button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

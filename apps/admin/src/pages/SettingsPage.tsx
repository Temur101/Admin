import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, Bell, CreditCard, ShieldAlert, Sparkles, Send } from "lucide-react";
import {
  getPlatformSettings,
  updatePlatformSettings,
  sendTestAlert,
  type PlatformTariff,
} from "../api/settings.js";
import { Button } from "../components/common/Button.js";
import { Input } from "../components/common/Input.js";
import { Alert } from "../components/common/Alert.js";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [paymentDetails, setPaymentDetails] = useState("");
  const [supportContact, setSupportContact] = useState("");
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [alertChatId, setAlertChatId] = useState("");
  const [tariff1m, setTariff1m] = useState(100000);
  const [tariff6m, setTariff6m] = useState(500000);
  const [tariff12m, setTariff12m] = useState(900000);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery({
    queryKey: ["platform-settings"],
    queryFn: getPlatformSettings,
  });

  useEffect(() => {
    if (settings) {
      setPaymentDetails(settings.paymentDetails || "");
      setSupportContact(settings.supportContact || "");
      setMaintenanceMode(settings.maintenanceMode ?? false);
      setAlertChatId(settings.alertChatId || "");

      if (Array.isArray(settings.tariffs)) {
        const t1 = settings.tariffs.find((t: PlatformTariff) => t.months === 1);
        const t6 = settings.tariffs.find((t: PlatformTariff) => t.months === 6);
        const t12 = settings.tariffs.find((t: PlatformTariff) => t.months === 12);
        if (t1) setTariff1m(t1.amountUzs || t1.priceUzs || 100000);
        if (t6) setTariff6m(t6.amountUzs || t6.priceUzs || 500000);
        if (t12) setTariff12m(t12.amountUzs || t12.priceUzs || 900000);
      }
    }
  }, [settings]);

  const saveMut = useMutation({
    mutationFn: () =>
      updatePlatformSettings({
        paymentDetails,
        supportContact,
        maintenanceMode,
        alertChatId: alertChatId ? alertChatId.trim() : undefined,
        tariffs: [
          { months: 1, amountUzs: Number(tariff1m) },
          { months: 6, amountUzs: Number(tariff6m) },
          { months: 12, amountUzs: Number(tariff12m) },
        ],
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["platform-settings"] });
      setFeedback("Настройки платформы успешно сохранены.");
      setErrorMsg(null);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || "Ошибка сохранения настроек");
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
    saveMut.mutate();
  };

  if (isLoading) {
    return <div className="p-8 text-center text-slate-500 text-xs">Загрузка настроек...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Настройки платформы</h1>
        <p className="text-xs text-slate-400 mt-1">
          Глобальные параметры оплат, реквизиты, оповещения владельца и тарифная сетка
        </p>
      </div>

      {feedback && (
        <Alert type="success" title="Успех">
          {feedback}
        </Alert>
      )}

      {errorMsg && (
        <Alert type="error" title="Ошибка">
          {errorMsg}
        </Alert>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Реквизиты и оплата */}
        <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl space-y-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-indigo-400" />
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
        <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl space-y-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-purple-400" />
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
        <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Bell className="h-4 w-4 text-amber-400" />
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

          <p className="text-xs text-slate-400 leading-relaxed">
            Отправляет мгновенные оповещения о новых поданных чеках, регистрации ботов и блокировках.
          </p>

          <Input
            label="ID чата владельца платформы (alertChatId)"
            placeholder="Например: 123456789"
            value={alertChatId}
            onChange={(e) => setAlertChatId(e.target.value)}
          />
        </div>

        {/* Технический перерыв */}
        <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-between">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-rose-400" />
              <span>Режим технического перерыва (Maintenance Mode)</span>
            </h3>
            <p className="text-xs text-slate-400">
              Временно приостанавливает диалоги в клиентских ботах с уведомлением о технических работах.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={maintenanceMode}
              onChange={(e) => setMaintenanceMode(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-800 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-600"></div>
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
      </form>
    </div>
  );
}

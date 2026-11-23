import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { formatGhanaPhone, normalizeGhanaPhone } from "@kiosk/shared";
import { api, RequestError } from "../lib/api.ts";
import { meKey } from "../lib/session.ts";
import { withTransition } from "../lib/transition.ts";
import { Button, Field } from "../components/ui.tsx";
import { OtpInput } from "../components/OtpInput.tsx";
import { AuthShell } from "./AuthShell.tsx";

type Step = { kind: "phone" } | { kind: "code"; phone: string; challengeId: string; resendAt: number };

export function Login() {
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function sendCode(e164: string) {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.requestOtp(e164);
      withTransition(() =>
        setStep({ kind: "code", phone: e164, challengeId: r.challengeId, resendAt: Date.now() + r.resendAfterMs }),
      );
    } catch (err) {
      setError(err instanceof RequestError ? (err.fields.phone ?? err.message) : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function onPhoneSubmit(e: FormEvent) {
    e.preventDefault();
    const r = normalizeGhanaPhone(phone);
    if (!r.ok) return setError(r.reason);
    void sendCode(r.e164);
  }

  return (
    <AuthShell
      title={step.kind === "phone" ? "Sell from your phone" : "Check WhatsApp"}
      lede={
        step.kind === "phone"
          ? "Sign in or open a store with your WhatsApp number. We'll send you a code there, no password needed."
          : `We sent a 6-digit code to ${formatGhanaPhone(step.phone)}.`
      }
    >
      {step.kind === "phone" ? (
        <form onSubmit={onPhoneSubmit} noValidate className="space-y-5" style={{ viewTransitionName: "step" }}>
          <Field
            label="WhatsApp number"
            prefix="+233"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="24 123 4567"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setError(undefined);
            }}
            error={error}
            autoFocus
          />
          <Button type="submit" busy={busy} className="w-full">
            Send code
          </Button>
        </form>
      ) : (
        <CodeStep
          key={step.challengeId}
          step={step}
          onResend={() => sendCode(step.phone)}
          onBack={() => withTransition(() => setStep({ kind: "phone" }))}
          onVerified={async () => {
            await qc.invalidateQueries({ queryKey: meKey });
            navigate("/", { replace: true });
          }}
        />
      )}
    </AuthShell>
  );
}

function CodeStep({
  step,
  onResend,
  onBack,
  onVerified,
}: {
  step: Extract<Step, { kind: "code" }>;
  onResend: () => void;
  onBack: () => void;
  onVerified: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const wait = Math.max(0, Math.ceil((step.resendAt - now) / 1000));

  async function verify(value: string) {
    setBusy(true);
    setError(undefined);
    try {
      await api.verifyOtp(step.challengeId, value);
      await onVerified();
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong.");
      setCode("");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" style={{ viewTransitionName: "step" }}>
      <OtpInput value={code} onChange={setCode} onComplete={verify} invalid={Boolean(error)} disabled={busy} />
      <p role="alert" className="min-h-5 text-sm text-danger">
        {error}
      </p>
      <Button busy={busy} className="w-full" disabled={code.length < 6} onClick={() => verify(code)}>
        Sign in
      </Button>
      <div className="flex items-center justify-between text-sm">
        <Button variant="quiet" type="button" onClick={onBack}>
          Use another number
        </Button>
        {wait > 0 ? (
          <span className="text-faint tabular-nums">Resend in {wait}s</span>
        ) : (
          <Button variant="quiet" type="button" onClick={onResend}>
            Resend code
          </Button>
        )}
      </div>
    </div>
  );
}

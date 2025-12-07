import React from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { Button } from "../../components/ui/Button";

export const Subscribe: React.FC = () => {
  const navigate = useNavigate();

  return (
    <AuthShell
      title="Get started with Stellar VPN"
      subtitle="Choose the right plan for you"
      onBack={() => navigate("/dashboard")}
    >
      <div className="space-y-4 text-sm">
        <div className="space-y-2">
          <PlanRow title="Monthly plan" price="€ 9.99 / month" />
          <PlanRow title="Yearly plan" price="€ 4.99 / month" highlighted />
          <PlanRow title="Weekly plan" price="€ 5.99 / week" />
        </div>

        <Button fullWidth className="mt-2">
          Subscribe
        </Button>

        <div className="mt-4 space-y-3">
          <h3 className="font-semibold text-base">
            Secure your online privacy with Stellar VPN
          </h3>
          <FeatureCard
            title="Worldwide servers"
            text="Global VPN coverage for all your devices."
          />
          <FeatureCard
            title="Multi-device compatibility"
            text="Use Stellar VPN on all your phones, tablets and computers."
          />
          <FeatureCard
            title="No logging"
            text="We do not log your online activity. Full privacy."
          />
        </div>
      </div>
    </AuthShell>
  );
};

type PlanRowProps = {
  title: string;
  price: string;
  highlighted?: boolean;
};

const PlanRow: React.FC<PlanRowProps> = ({ title, price, highlighted }) => {
  return (
    <div
      className={[
        "flex items-center justify-between rounded-full border px-4 py-3",
        highlighted ? "border-[#256BFF] bg-[#eef3ff]" : "border-slate-200"
      ].join(" ")}
    >
      <span className="font-medium">{title}</span>
      <span className="text-sm text-slate-600">{price}</span>
    </div>
  );
};

type FeatureProps = {
  title: string;
  text: string;
};

const FeatureCard: React.FC<FeatureProps> = ({ title, text }) => {
  return (
    <div className="rounded-2xl border border-slate-100 p-3 bg-slate-50">
      <div className="font-medium mb-1">{title}</div>
      <div className="text-xs text-slate-500">{text}</div>
    </div>
  );
};

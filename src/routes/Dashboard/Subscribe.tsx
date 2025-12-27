import React, { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Slider from "react-slick";
import "slick-carousel/slick/slick.css";
import "slick-carousel/slick/slick-theme.css";
import { AuthShell } from "../../components/layout/AuthShell";
import { Button } from "../../components/ui/Button";

export const Subscribe: React.FC = () => {
  const navigate = useNavigate();
  const sliderRef = useRef<Slider>(null);
  const [selectedPlan, setSelectedPlan] = useState<string>("yearly");

  const testimonials = [
    {
      id: 1,
      text: "I recently lost my phone while traveling, and I was worried about my personal data falling into the wrong hands. Thanks to Stellar Protect's remote wipe feature, I was able to erase all my data remotely and avoid a potential disaster!",
      name: "David Stevens",
      company: "SecureData Corp",
      image:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%232761FC'/%3E%3Ctext x='50%25' y='50%25' font-size='20' fill='white' text-anchor='middle' dominant-baseline='middle' font-family='Arial'%3EDS%3C/text%3E%3C/svg%3E",
    },
    {
      id: 2,
      text: "Stellar VPN has been a game-changer for my business. The security and speed are unmatched, and I can work from anywhere with complete peace of mind.",
      name: "Sarah Johnson",
      company: "Tech Solutions Inc",
      image:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%232761FC'/%3E%3Ctext x='50%25' y='50%25' font-size='20' fill='white' text-anchor='middle' dominant-baseline='middle' font-family='Arial'%3ESJ%3C/text%3E%3C/svg%3E",
    },
    {
      id: 3,
      text: "As someone who travels frequently, Stellar VPN keeps me connected and secure no matter where I am. Highly recommend it to anyone who values their privacy.",
      name: "Michael Chen",
      company: "Global Ventures",
      image:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%232761FC'/%3E%3Ctext x='50%25' y='50%25' font-size='20' fill='white' text-anchor='middle' dominant-baseline='middle' font-family='Arial'%3EMC%3C/text%3E%3C/svg%3E",
    },
  ];

  const settings = {
    dots: false,
    infinite: true,
    speed: 500,
    slidesToShow: 1,
    slidesToScroll: 1,
    arrows: false,
    centerMode: true,
    centerPadding: "20px",
    autoplay: true,
    autoplaySpeed: 3000,
  };

  return (
    <AuthShell onBack={() => navigate("/dashboard")}>
      <h2 className="text-xs font-semibold text-[#62626A] my-2">
        Select your VPN plan
      </h2>
      <div className="space-y-4 text-sm">
        <div className="space-y-2">
          <PlanRow
            title="Monthly plan"
            price="€ 9.99 / month"
            highlighted={selectedPlan === "monthly"}
            onClick={() => setSelectedPlan("monthly")}
          />
          <PlanRow
            title="Yearly plan"
            price="€ 4.99 / month"
            highlighted={selectedPlan === "yearly"}
            onClick={() => setSelectedPlan("yearly")}
          />
          <PlanRow
            title="Weekly plan"
            price="€ 5.99 / week"
            highlighted={selectedPlan === "weekly"}
            onClick={() => setSelectedPlan("weekly")}
          />
        </div>

        <Button
          fullWidth
          className="mt-2 text-base bg-[#2761FC]"
          onClick={() => window.open("https://stellarsecurity.com", "_blank")}
        >
          Subscribe
        </Button>

        <div className="mt-4 space-y-3">
          <h3 className="font-bold text-xl rounded-2xl border border-[#EAEAF0] py-8 px-5">
            Secure your online <br />
            privacy with
            <span className="text-[#2761FC]"> Stellar VPN</span>
          </h3>
          <FeatureCard
            image="/icons/world-check.svg"
            title="Worldwide servers"
            text="Global VPN coverage"
          />
          <FeatureCard
            image="/icons/devices.svg"
            title="Multi-device compatibility"
            text="Use on unlimited devices"
          />
          <FeatureCard
            image="/icons/no-file.svg"
            title="No logging"
            text="Our VPN service never logs your online activity, ensuring complete anonymity."
          />
        </div>

        {/* Testimonials Slider Section */}
        <div className="mt-6">
          <h3 className="text-center text-xl font-bold text-[#0B0C19] mt-10 mb-5">
            Testimonials
          </h3>
          <div className="relative -ml-5 -mr-5">
            <Slider ref={sliderRef} {...settings}>
              {testimonials.map((testimonial) => (
                <div key={testimonial.id} className="px-2">
                  <div className="bg-white rounded-4xl border border-[#EAEAF0] p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <img
                        src="/icons/arrows.svg"
                        alt="Quote"
                        className="w-[34px] h-[26px]"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          target.style.display = "none";
                        }}
                      />
                    </div>
                    <p className="text-[16px] font-semibold text-[#0B0C19] mb-8">
                      {testimonial.text}
                    </p>
                    <div className="flex items-center gap-3">
                      <img
                        src={testimonial.image}
                        alt={testimonial.name}
                        className="w-12 h-12 rounded-full object-cover"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          target.src = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%232761FC'/%3E%3Ctext x='50%25' y='50%25' font-size='18' fill='white' text-anchor='middle' dominant-baseline='middle' font-family='Arial'%3E${testimonial.name.charAt(
                            0
                          )}%3C/text%3E%3C/svg%3E`;
                        }}
                      />
                      <div>
                        <div className="font-regular text-sm text-[#0B0C19]">
                          {testimonial.name}
                        </div>
                        <div className="text-xs text-[#62626A]">
                          {testimonial.company}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </Slider>
          </div>
        </div>

        {/* Subscribe Button at the end */}
        <div className="mt-6 pb-8">
          <Button
            fullWidth
            className="text-base bg-[#2761FC]"
            onClick={() => window.open("https://stellarsecurity.com", "_blank")}
          >
            Subscribe
          </Button>
        </div>
      </div>
    </AuthShell>
  );
};

type PlanRowProps = {
  title: string;
  price: string;
  highlighted?: boolean;
  onClick?: () => void;
};

const PlanRow: React.FC<PlanRowProps> = ({
  title,
  price,
  highlighted,
  onClick,
}) => {
  return (
    <div
      onClick={onClick}
      className={[
        "flex items-center justify-between rounded-full border px-5 cursor-pointer transition-all",
        highlighted
          ? "border-[#2761FC] bg-transparent text-[#2761FC] font-semibold"
          : "border-slate-200 hover:border-slate-300",
      ].join(" ")}
    >
      <span className="font-regular">{title}</span>
      <span
        className={[
          "flex items-center justify-between h-[53px]",
          highlighted
            ? "border-[#2761FC] bg-transparent text-[#2761FC] font-semibold"
            : "border-slate-200",
        ].join(" ")}
      >
        {price}
      </span>
    </div>
  );
};

type FeatureProps = {
  image: string;
  title: string;
  text: string;
};

const FeatureCard: React.FC<FeatureProps> = ({ image, title, text }) => {
  return (
    <div className="rounded-3xl border border-[#EAEAF0] p-6">
      <img
        src={image}
        alt="Checkmark"
        className="w-11 h-11 mb-4 mt-0 mx-auto"
      />
      <div className="font-semibold text-[16px] text-[#0B0C19] mb-2">
        {title}
      </div>
      <div className="text-sm text-[#0B0C19]">{text}</div>
    </div>
  );
};

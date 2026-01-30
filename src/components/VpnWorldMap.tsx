import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
    ComposableMap,
    Geographies,
    Geography,
    ZoomableGroup,
} from "react-simple-maps";
import { geoCentroid } from "d3-geo";

type UiStatus = "disconnected" | "connecting" | "connected";

type Props = {
    focusCountryCode?: string | null;
    selectedCountryCode?: string | null;
    onCountryClick?: (countryCode: string) => void;
    height?: number;
    animateKey?: number; // bump this to force re-fly even to same country
    connectionStatus?: UiStatus; // 👈 NEW: pass status from Dashboard
};

type Feature = {
    type: "Feature";
    properties?: Record<string, any>;
    geometry: any;
};

const GEO_URL = "/maps/ne_110m_admin_0_countries.geojson";

const upper = (s?: string | null) => (s || "").trim().toUpperCase();

const prefersReducedMotion = () => {
    if (typeof window === "undefined") return true;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// smooth + “cinematic”
const easeInOutCubic = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const VpnWorldMap: React.FC<Props> = ({
                                                 focusCountryCode,
                                                 selectedCountryCode,
                                                 onCountryClick,
                                                 height = 640,
                                                 animateKey = 0,
                                                 connectionStatus = "disconnected",
                                             }) => {
    const [geo, setGeo] = useState<{ type: string; features: Feature[] } | null>(null);
    const [loadErr, setLoadErr] = useState<string | null>(null);

    const focusCC = upper(focusCountryCode);
    const selectedCC = upper(selectedCountryCode);

    const isConnected = connectionStatus === "connected";
    const isConnecting = connectionStatus === "connecting";

    // Default view (world-ish)
    const defaultCenter: [number, number] = [0, 20];
    const defaultZoom = 1;

    // Rendered (animated) view
    const [viewCenter, setViewCenter] = useState<[number, number]>(defaultCenter);
    const [viewZoom, setViewZoom] = useState<number>(defaultZoom);

    // Animation bookkeeping
    const rafRef = useRef<number | null>(null);
    const animTokenRef = useRef<number>(0);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const res = await fetch(GEO_URL, { cache: "force-cache" });
                if (!res.ok) throw new Error(`GeoJSON HTTP ${res.status}`);
                const json = await res.json();
                if (!cancelled) setGeo(json);
            } catch (e: any) {
                if (!cancelled) {
                    setLoadErr(e?.message ? String(e.message) : "Failed to load map data");
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    const focusFeature = useMemo(() => {
        if (!geo?.features?.length || !focusCC) return null;
        return geo.features.find((f) => upper(f.properties?.ISO_A2) === focusCC) || null;
    }, [geo, focusCC]);

    const selectedFeature = useMemo(() => {
        if (!geo?.features?.length || !selectedCC) return null;
        return geo.features.find((f) => upper(f.properties?.ISO_A2) === selectedCC) || null;
    }, [geo, selectedCC]);

    const targetCenter: [number, number] = useMemo(() => {
        const f = focusFeature || selectedFeature;
        if (!f) return defaultCenter;

        const c = geoCentroid(f as any) as [number, number];
        if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return defaultCenter;
        return c;
    }, [focusFeature, selectedFeature]);

    const targetZoom = useMemo(() => {
        if (focusFeature) return 2.6;
        if (selectedFeature) return 2.0;
        return defaultZoom;
    }, [focusFeature, selectedFeature]);

    const cancelAnim = useCallback(() => {
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
    }, []);

    const flyTo = useCallback(
        (toCenter: [number, number], toZoom: number, durationMs: number) => {
            cancelAnim();
            animTokenRef.current += 1;
            const token = animTokenRef.current;

            const fromCenter = viewCenter;
            const fromZoom = viewZoom;

            if (prefersReducedMotion()) {
                setViewCenter(toCenter);
                setViewZoom(toZoom);
                return;
            }

            const start = performance.now();

            const tick = (now: number) => {
                if (animTokenRef.current !== token) return;

                const tRaw = (now - start) / durationMs;
                const t = Math.min(1, Math.max(0, tRaw));
                const e = easeInOutCubic(t);

                // “fly-over” feel: tiny zoom bump mid-flight
                const bump = 0.18 * Math.sin(Math.PI * e);

                const cx = lerp(fromCenter[0], toCenter[0], e);
                const cy = lerp(fromCenter[1], toCenter[1], e);
                const z = lerp(fromZoom, toZoom, e) + bump;

                setViewCenter([cx, cy]);
                setViewZoom(z);

                if (t < 1) {
                    rafRef.current = requestAnimationFrame(tick);
                } else {
                    setViewCenter(toCenter);
                    setViewZoom(toZoom);
                    rafRef.current = null;
                }
            };

            rafRef.current = requestAnimationFrame(tick);
        },
        [cancelAnim, viewCenter, viewZoom]
    );

    // Trigger animation when target changes OR animateKey changes
    useEffect(() => {
        if (!geo) return;

        const dur = focusCC ? 900 : selectedCC ? 700 : 450;
        flyTo(targetCenter, targetZoom, dur);

        return () => cancelAnim();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [geo, targetCenter[0], targetCenter[1], targetZoom, animateKey, focusCC, selectedCC]);

    if (loadErr) {
        return <div className="text-[11px] text-white/70">Map failed to load: {loadErr}</div>;
    }

    if (!geo) {
        return (
            <div className="flex items-center gap-2 text-[11px] text-white/70">
                <div className="w-4 h-4 rounded-full border-2 border-white/20 border-t-white/70 animate-spin" />
                Loading map…
            </div>
        );
    }

    return (
        <div className="w-full h-full">
            <ComposableMap
                projection="geoMercator"
                style={{ width: "100%", height }}
                projectionConfig={{ scale: 110 }}
            >
                <ZoomableGroup
                    center={viewCenter}
                    zoom={viewZoom}
                    disablePanning={!onCountryClick}
                    disableZooming
                >
                    <Geographies geography={geo}>
                        {({ geographies }) =>
                            geographies.map((g) => {
                                const cc = upper((g as any).properties?.ISO_A2);
                                const isFocus = !!focusCC && cc === focusCC;
                                const isSelected = !!selectedCC && cc === selectedCC;

                                // Base: sexy blue land
                                const baseFill = "rgba(39,97,252,0.22)";

                                // Focus is always Stellar blue (it’s just “focus”, not “connected”)
                                const focusFill = "rgba(39,97,252,0.92)";

                                // Selected ONLY turns green when connected
                                const selectedFill = isConnected
                                    ? "rgba(0,178,82,0.90)"
                                    : isConnecting
                                        ? "rgba(39,97,252,0.55)" // subtle “working on it” highlight
                                        : "rgba(39,97,252,0.40)"; // selected but not connected

                                const fill = isFocus ? focusFill : isSelected ? selectedFill : baseFill;

                                // Stroke: keep it readable without turning everything into mud
                                const stroke = "rgba(0,0,0,0.22)";

                                return (
                                    <Geography
                                        key={(g as any).rsmKey}
                                        geography={g}
                                        onClick={() => {
                                            if (!onCountryClick) return;
                                            if (!cc || cc === "-99") return;
                                            onCountryClick(cc);
                                        }}
                                        style={{
                                            default: { fill, stroke, outline: "none" },
                                            hover: {
                                                fill: isFocus
                                                    ? "rgba(39,97,252,0.95)"
                                                    : isSelected
                                                        ? (isConnected
                                                            ? "rgba(0,178,82,0.95)"
                                                            : isConnecting
                                                                ? "rgba(39,97,252,0.62)"
                                                                : "rgba(39,97,252,0.48)")
                                                        : "rgba(39,97,252,0.32)",
                                                stroke: "rgba(0,0,0,0.28)",
                                                outline: "none",
                                                cursor: onCountryClick ? "pointer" : "default",
                                            },
                                            pressed: { fill, stroke, outline: "none" },
                                        }}
                                    />
                                );
                            })
                        }
                    </Geographies>
                </ZoomableGroup>
            </ComposableMap>
        </div>
    );
};

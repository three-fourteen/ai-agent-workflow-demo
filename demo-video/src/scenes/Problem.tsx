import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, ease, font } from "../theme";

const steps = [
  { label: "Agent", color: colors.blue },
  { label: "Code", color: colors.accent },
  { label: "Session ends", color: colors.amber },
  { label: "Context lost", color: colors.red },
];

export const Problem: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill name="Background" style={{ background: colors.bg, fontFamily: font, justifyContent: "center", alignItems: "center", gap: 90 }}>
      <Interactive.Div
        name="Heading"
        style={{
          fontSize: 92, fontWeight: 800, color: colors.text,
          opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        Agents write code, then forget.
      </Interactive.Div>
      <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
        {steps.map((s, i) => {
          const start = 25 + i * 20;
          return (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 36 }}>
              <Interactive.Div
                name={`Step ${s.label}`}
                style={{
                  fontSize: 48, fontWeight: 700, color: s.color, padding: "28px 44px",
                  border: `3px solid ${s.color}`, borderRadius: 24, background: colors.panel,
                  opacity: interpolate(frame, [start, start + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
                  scale: interpolate(frame, [start, start + 15], [0.8, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
                }}
              >
                {s.label}
              </Interactive.Div>
              {i < steps.length - 1 && (
                <div style={{ fontSize: 56, color: colors.muted, opacity: interpolate(frame, [start + 10, start + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>→</div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

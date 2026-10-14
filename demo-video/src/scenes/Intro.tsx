import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, ease, font, mono } from "../theme";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      name="Background"
      style={{ background: colors.bg, justifyContent: "center", alignItems: "center", fontFamily: font, gap: 28 }}
    >
      <Interactive.Div
        name="Badge"
        style={{
          fontFamily: mono, fontSize: 40, color: colors.accent,
          opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        git-native · agent-workflow
      </Interactive.Div>
      <Interactive.Div
        name="Title"
        style={{
          fontSize: 120, fontWeight: 800, color: colors.text, textAlign: "center", lineHeight: 1.05,
          opacity: interpolate(frame, [10, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
          translate: interpolate(frame, [10, 40], ["0px 60px", "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        Task orchestration
        <br />
        for AI coding agents
      </Interactive.Div>
      <Interactive.Div
        name="Subtitle"
        style={{
          fontSize: 48, color: colors.muted,
          opacity: interpolate(frame, [40, 65], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
        }}
      >
        Workflow state lives in the repository.
      </Interactive.Div>
    </AbsoluteFill>
  );
};

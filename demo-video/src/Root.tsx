import { Composition, Folder } from "remotion";
import { Demo } from "./Demo";
import { Intro } from "./scenes/Intro";
import { Problem } from "./scenes/Problem";
import { StateMachine } from "./scenes/StateMachine";
import { Terminal } from "./scenes/Terminal";
import { Projects } from "./scenes/Projects";
import { Outro } from "./scenes/Outro";

const common = { width: 1920, height: 1080, fps: 30 } as const;

export const RemotionRoot: React.FC = () => (
  <>
    <Folder name="Demo-Scenes">
      <Composition id="Intro" component={Intro} durationInFrames={90} {...common} />
      <Composition id="Problem" component={Problem} durationInFrames={120} {...common} />
      <Composition id="StateMachine" component={StateMachine} durationInFrames={150} {...common} />
      <Composition id="Terminal" component={Terminal} durationInFrames={210} {...common} />
      <Composition id="Projects" component={Projects} durationInFrames={120} {...common} />
      <Composition id="Outro" component={Outro} durationInFrames={90} {...common} />
    </Folder>
    <Composition id="Demo" component={Demo} durationInFrames={780} {...common} />
  </>
);

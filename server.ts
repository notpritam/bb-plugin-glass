// bb-plugin-glass — backend entry.
//
// Config store for the Glass look: a translucent, blurred "glassy" treatment
// over an ambient animated backdrop (aurora / glow / nebula / custom image),
// Warp-style. The frontend content script reads this config and paints the
// whole app; the Glass panel edits it live.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// flow/aurora/nebula/waves render on a WebGL fragment shader; glow/image are
// CSS layers; none = transparency only.
const STYLES = [
  "flow",
  "aurora",
  "nebula",
  "waves",
  "glow",
  "image",
  "none",
] as const;

const configSchema = z.object({
  enabled: z.boolean(),
  /** Surface opacity 55–100 (%). Lower = more see-through glass. */
  opacity: z.number().min(55).max(100),
  /** Backdrop blur radius 0–80 px (blurs the glow layer itself). */
  blur: z.number().min(0).max(80),
  /** Ambient backdrop style behind the UI. */
  style: z.enum(STYLES),
  /** Wallpaper URL when style = "image". */
  imageUrl: z.string(),
  /** Slow ambient motion on the backdrop. */
  animate: z.boolean(),
  /** Darkening scrim 0–70 (%) for readability over bright backdrops. */
  dim: z.number().min(0).max(70),
  /** Film-grain overlay strength 0–40 (%). */
  grain: z.number().min(0).max(40),
  /** Animation speed 10–300 (%) for shader/ambient motion. */
  speed: z.number().min(10).max(300),
  /** Sidebar surface opacity 60–100 (%) — kept higher so its UI stays legible. */
  sidebarOpacity: z.number().min(60).max(100),
  /** Sidebar frost: backdrop blur 0–40 px applied to the sidebar itself. */
  sidebarBlur: z.number().min(0).max(40),
  /** Chat-input frost: backdrop blur 0–40 px behind the composer. */
  composerBlur: z.number().min(0).max(40),
  /** Master switch for the chat-input frost region (off = stock composer). */
  composerFrost: z.boolean(),
  /** Frost dialogs / popovers / menus (off = near-opaque stock surfaces). */
  modalFrost: z.boolean(),
  /** Modal & menu backdrop blur 0–40 px. */
  modalBlur: z.number().min(0).max(40),
});
export type GlassConfig = z.infer<typeof configSchema>;

const DEFAULT_CONFIG: GlassConfig = {
  enabled: false,
  opacity: 82,
  blur: 44,
  style: "flow",
  imageUrl: "",
  animate: true,
  dim: 30,
  grain: 12,
  speed: 100,
  sidebarOpacity: 94,
  sidebarBlur: 18,
  composerBlur: 24,
  composerFrost: true,
  modalFrost: true,
  modalBlur: 20,
};

const CONFIG_KEY = "config";

export const rpcContract = defineRpcContract({
  getConfig: { input: z.null(), output: configSchema },
  setConfig: {
    input: configSchema.partial().strict(),
    output: configSchema,
  },
  resetConfig: { input: z.null(), output: configSchema },
});

export default async function plugin(bb: BbPluginApi) {
  async function readConfig(): Promise<GlassConfig> {
    const stored = await bb.storage.kv.get<Partial<GlassConfig>>(CONFIG_KEY);
    const parsed = configSchema.safeParse({ ...DEFAULT_CONFIG, ...stored });
    return parsed.success ? parsed.data : DEFAULT_CONFIG;
  }

  bb.rpc.register(rpcContract, {
    getConfig: () => readConfig(),
    setConfig: async (patch) => {
      const next = { ...(await readConfig()), ...patch };
      await bb.storage.kv.set(CONFIG_KEY, next);
      bb.realtime.publish("glass", { config: next });
      return next;
    },
    resetConfig: async () => {
      await bb.storage.kv.delete(CONFIG_KEY);
      bb.realtime.publish("glass", { config: DEFAULT_CONFIG });
      return DEFAULT_CONFIG;
    },
  });

  bb.onDispose(() => bb.log.info("glass disposed"));
}

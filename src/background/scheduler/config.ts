/**
 * 调度层配置类型与默认值（架构第 5.3 节）。
 *
 * 注：架构将 SchedulingConfig / 默认调度参数放在 `src/shared/types.ts` 与
 * `src/shared/constants.ts`（P0-2 / TRA-3 交付）。当前 P0-2 尚未合并，为不阻塞
 * 并行开发、且不与 P0-2 的 shared 文件冲突，这里在调度模块内本地定义调度专用
 * 配置。P0-2 落地后应由 orchestrator 集成阶段统一收敛到 shared，本模块届时改为
 * 从 shared import 即可。
 */

/** 调度配置（对应架构 5.3 配置项）。 */
export interface SchedulingConfig {
  /** 全局最大并发请求数（默认 3，可配 1–10）。全局唯一 Service Worker 内生效。 */
  maxConcurrent: number;
  /** 每秒请求数上限（令牌桶 RPS，默认 2，防 429）。 */
  rps: number;
  /** 每分钟 token 上限（令牌桶 TPM，0 = 关闭；开启时 acquire 的 cost 按批 token 量计）。 */
  tpmLimit: number;
  /** 单批最大重试次数（默认 5）。 */
  maxRetries: number;
  /** 单批最大段数上限（打包器用，默认 20）。 */
  itemsPerBatch: number;
  /** 输入 token 占窗口比例（打包器用，默认 0.7）。 */
  batchTokenBudgetRatio: number;
}

/** AIMD 降速参数（架构 5.2）。 */
export interface AimdConfig {
  /**
   * 429 后连续成功多少次才恢复到目标 RPS（架构：「连续成功 N 次恢复」）。默认 5。
   */
  recoveryThreshold: number;
  /** RPS 降速下限，避免被压到接近 0。默认 0.5。 */
  minRps: number;
}

/** 调度默认值（架构 5.3）。 */
export const DEFAULT_SCHEDULING: SchedulingConfig = {
  maxConcurrent: 3,
  rps: 2,
  tpmLimit: 0,
  maxRetries: 5,
  itemsPerBatch: 20,
  batchTokenBudgetRatio: 0.7,
};

/** AIMD 默认值。 */
export const DEFAULT_AIMD: AimdConfig = {
  recoveryThreshold: 5,
  minRps: 0.5,
};

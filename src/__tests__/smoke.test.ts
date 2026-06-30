/**
 * 最小 vitest smoke 用例 —— 验证测试基座可跑（jsdom 环境 + fake-indexeddb setup 生效），
 * 并断言核心共享导出存在，防止构建/路径漂移导致后续用例静默失收。
 * 对应 issue TRA-14 交付物 #3。
 */
import { describe, it, expect } from 'vitest';
import {
  ENGINE_PROVIDERS,
  DEFAULT_SCHEDULING,
  translatePortName,
  parseTranslatePortName,
  CACHE_DB_NAME,
} from '../shared/constants';
import type { EngineProvider, SchedulingConfig, Paragraph } from '../shared/types';

describe('smoke: 测试基座', () => {
  it('vitest 断言可用', () => {
    expect(1 + 1).toBe(2);
    expect([1, 2, 3]).toHaveLength(3);
  });

  it('jsdom DOM 环境已注入', () => {
    const el = document.createElement('div');
    el.textContent = 'hello';
    document.body.appendChild(el);
    expect(el.textContent).toBe('hello');
    expect(el.isConnected).toBe(true);
  });

  it('fake-indexeddb setup 已注入全局 indexedDB', () => {
    expect(typeof indexedDB).toBe('object');
    expect(typeof IDBKeyRange).toBe('function');
  });
});

describe('smoke: 共享模块导出存在', () => {
  it('ENGINE_PROVIDERS 与默认调度参数导出正常', () => {
    expect(ENGINE_PROVIDERS.length).toBeGreaterThan(0);
    expect(DEFAULT_SCHEDULING.maxConcurrent).toBeGreaterThan(0);
    expect(DEFAULT_SCHEDULING.itemsPerBatch).toBeGreaterThan(0);
  });

  it('Port 名称工具函数可往返', () => {
    const name = translatePortName(123);
    expect(name.startsWith('translate:')).toBe(true);
    expect(parseTranslatePortName(name)).toBe(123);
    expect(parseTranslatePortName('not-a-translate-port')).toBeUndefined();
  });

  it('缓存 DB 常量已定义', () => {
    expect(CACHE_DB_NAME).toBeTruthy();
  });

  it('共享类型可作为类型注解使用（编译期断言）', () => {
    const provider: EngineProvider = ENGINE_PROVIDERS[0]!;
    const sched: SchedulingConfig = { ...DEFAULT_SCHEDULING };
    const para: Paragraph = { id: 'p1', text: 'hi' };
    expect(provider).toBeTruthy();
    expect(sched).toBeDefined();
    expect(para.id).toBe('p1');
  });
});

/**
 * 进行中操作：特性登记「正在进行、用户可随时干预」的操作及其动作（如录制的暂停/停止、
 * Computer Use 的急停），宿主统一渲染到托盘等常驻入口。每个特性同一时刻至多一项。
 *
 * 文案以 i18n 键登记，由宿主渲染时翻译，语言切换后无需特性重新登记。
 */

export interface FeatureActivityAction {
  id: string;
  labelKey: string;
  run(): void;
}

export interface FeatureActivity {
  actions: readonly FeatureActivityAction[];
}

export interface FeatureActivities {
  /** 登记或清除（null）本特性当前的进行中操作。 */
  set(activity: FeatureActivity | null): void;
}

export interface ActivityEntry {
  featureId: string;
  activity: FeatureActivity;
}

export interface ActivityBoard {
  forFeature(featureId: string): FeatureActivities;
  /** 按特性登记顺序（注册表顺序）返回当前进行中的操作。 */
  list(): ActivityEntry[];
  /** 执行某特性当前登记的动作；无此动作返回 false。 */
  run(featureId: string, actionId: string): boolean;
  subscribe(listener: (entries: ActivityEntry[]) => void): () => void;
  clear(): void;
}

export function createActivityBoard(
  order: readonly string[],
  onListenerError: (error: unknown) => void = () => undefined,
): ActivityBoard {
  const current = new Map<string, FeatureActivity>();
  const listeners = new Set<(entries: ActivityEntry[]) => void>();
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index < 0 ? order.length : index;
  };
  const list = (): ActivityEntry[] =>
    [...current.entries()]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([featureId, activity]) => ({ featureId, activity }));
  const emit = () => {
    const entries = list();
    for (const listener of [...listeners]) {
      try {
        listener(entries);
      } catch (error) {
        onListenerError(error);
      }
    }
  };

  return {
    forFeature(featureId) {
      return {
        set(activity) {
          if (!activity || activity.actions.length === 0) {
            if (!current.delete(featureId)) return;
          } else {
            current.set(featureId, { actions: [...activity.actions] });
          }
          emit();
        },
      };
    },
    list,
    run(featureId, actionId) {
      const action = current.get(featureId)?.actions.find((item) => item.id === actionId);
      if (!action) return false;
      action.run();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clear() {
      if (current.size === 0) return;
      current.clear();
      emit();
    },
  };
}

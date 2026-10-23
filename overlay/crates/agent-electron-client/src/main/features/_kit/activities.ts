/**
 * 特性操作入口：登记当前可用的本机任务入口及进行中动作（如任务中心、录制暂停/停止），
 * 宿主统一渲染到托盘。入口存在不代表任务运行，也不得触发后台服务启动。每个特性至多一组。
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
  /** 登记或清除（null）本特性当前可用的操作入口与动作。 */
  set(activity: FeatureActivity | null): void;
}

export interface ActivityEntry {
  featureId: string;
  activity: FeatureActivity;
}

export interface ActivityBoard {
  forFeature(featureId: string): FeatureActivities;
  /** 按特性登记顺序（注册表顺序）返回当前可用的操作入口。 */
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

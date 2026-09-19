import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api/client';

export type StepKey = 'products' | 'prices' | 'stock' | 'firstSale';

export interface OnboardingStep {
  key: StepKey;
  title: string;
  done: boolean;
  skipped: boolean;
  optional: boolean;
  detail: string;
}

export interface OnboardingState {
  complete: boolean;
  dismissed: boolean;
  fresh: boolean;
  steps: OnboardingStep[];
  doneCount: number;
}

export function useOnboarding() {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api.get<OnboardingState>('/api/onboarding'),
    // 向导要跟着操作走：卖出第一笔之后，清单必须立刻消失，
    // 而不是等 staleTime 过期 —— 老板会以为没生效，再卖一笔
    staleTime: 0,
  });
}

/** 做完一步就把相关查询全刷一遍，免得各处状态对不上 */
export function useRefreshOnboarding() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['onboarding'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['products'] });
  };
}

export function useDismissOnboarding() {
  const refresh = useRefreshOnboarding();
  return useMutation({
    mutationFn: (on: boolean) => api.post<OnboardingState>('/api/onboarding/dismiss', { on }),
    onSuccess: refresh,
  });
}

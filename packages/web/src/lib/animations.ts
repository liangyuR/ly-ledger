/** 列表行淡入 + 轻微上移，第几行就晚多久出现 —— 别做长动画，柜台上没人等特效 */
export function rowIn(index: number) {
  return {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.16, delay: Math.min(index, 8) * 0.025 },
  };
}

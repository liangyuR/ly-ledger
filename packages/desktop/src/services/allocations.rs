//! FIFO 核销 —— 纯函数，不碰数据库。
//!
//! **核销是派生结果，不是历史记录。** 输入是某客户的全部挂账单和全部收款，
//! 输出唯一确定，可以随时整体重算。
//!
//! 为什么必须这样：业务日期可改、补录是常态（红线 2），而核销按 biz_date
//! 升序 FIFO。老板补录一张上个月的单，它就该排进队列更靠前的位置 ——
//! 已写好的核销记录不会自己更新，结果是**账龄算错**，而账龄正是收款页的
//! 排序依据、老板决定先给谁打电话的依据。详见 docs/05。

use chrono::NaiveDate;

#[derive(Debug, Clone)]
pub struct SaleForAlloc {
    pub id: i64,
    /// YYYY-MM-DD
    pub biz_date: String,
    /// 应收，分。退货单为负
    pub total_cents: i64,
    /// 本单是哪张单的退货；非退货单为 None
    pub return_of_sale_id: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct PaymentForAlloc {
    pub id: i64,
    pub biz_date: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allocation {
    pub payment_id: i64,
    pub sale_id: i64,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outstanding {
    pub sale_id: i64,
    pub biz_date: String,
    pub outstanding_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllocResult {
    pub allocations: Vec<Allocation>,
    /// 分配不完的收款余额 = 预收。为 0 表示没有预收
    pub prepaid_cents: i64,
    /// 每张单还欠多少，用于账龄与详情页
    pub outstanding: Vec<Outstanding>,
}

/// 重算某个客户的全部核销。
///
/// 退货的处理：退货单通过 `return_of_sale_id` **直接抵减它对应的原单**，
/// 而不是当成一笔独立的「负债务」扔进 FIFO 队列。因为退货天然是针对某一单的，
/// 抵在原单上语义更准，也不需要给核销表增加「这笔核销来自退货」的字段。
pub fn compute_allocations(sales: &[SaleForAlloc], payments: &[PaymentForAlloc]) -> AllocResult {
    // 退货按原单归集
    let mut returns_by_sale: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for s in sales {
        if let Some(origin) = s.return_of_sale_id {
            *returns_by_sale.entry(origin).or_insert(0) += s.total_cents;
        }
    }

    let mut debts: Vec<Debt> = sales
        .iter()
        .filter(|s| s.return_of_sale_id.is_none())
        .map(|s| Debt {
            id: s.id,
            biz_date: s.biz_date.clone(),
            // 退货金额为负，加上去就是抵减
            remaining: s.total_cents + returns_by_sale.get(&s.id).copied().unwrap_or(0),
        })
        .filter(|d| d.remaining > 0)
        .collect();

    // (biz_date, id) 升序。带 id 是为了消除同日多单的歧义 ——
    // 否则重算结果不稳定，单测会随机失败
    debts.sort_by(|a, b| (&a.biz_date, a.id).cmp(&(&b.biz_date, b.id)));

    let mut credits: Vec<&PaymentForAlloc> = payments.iter().collect();
    credits.sort_by(|a, b| (&a.biz_date, a.id).cmp(&(&b.biz_date, b.id)));

    let mut allocations: Vec<Allocation> = Vec::new();
    let mut cursor = 0usize;

    for (idx, payment) in credits.iter().enumerate() {
        let mut left = payment.amount_cents;

        while left > 0 && cursor < debts.len() {
            let debt = &mut debts[cursor];
            let take = left.min(debt.remaining);

            allocations.push(Allocation {
                payment_id: payment.id,
                sale_id: debt.id,
                amount_cents: take,
            });
            debt.remaining -= take;
            left -= take;

            if debt.remaining == 0 {
                cursor += 1;
            }
        }

        // 收款用尽即止；所有单填满后仍有剩余 → 预收，不写核销记录
        if left > 0 {
            let rest: i64 = credits[idx + 1..].iter().map(|p| p.amount_cents).sum();
            return AllocResult {
                allocations,
                prepaid_cents: left + rest,
                outstanding: to_outstanding(&debts),
            };
        }
    }

    AllocResult {
        allocations,
        prepaid_cents: 0,
        outstanding: to_outstanding(&debts),
    }
}

/// FIFO 队列里的一张欠单。`remaining` 在分配过程中被逐步扣减。
struct Debt {
    id: i64,
    biz_date: String,
    remaining: i64,
}

fn to_outstanding(debts: &[Debt]) -> Vec<Outstanding> {
    debts
        .iter()
        .map(|d| Outstanding {
            sale_id: d.id,
            biz_date: d.biz_date.clone(),
            outstanding_cents: d.remaining,
        })
        .collect()
}

/// 账龄：最早一张未结清单距今多少天。没有欠款返回 None。
///
/// 欠款列表走的是 SQL 那条路（`reports::list_debts`），这里这个是纯函数版，
/// 跟它服务的 FIFO 逻辑放在一起，由核销那组用例钉着 ——
/// 「补录一张更早的单，账龄该不该变」这条结论就靠它说清楚。
#[allow(dead_code)]
pub fn aging_days(result: &AllocResult, today: &str) -> Option<i64> {
    let earliest = result
        .outstanding
        .iter()
        .filter(|o| o.outstanding_cents > 0)
        .min_by(|a, b| a.biz_date.cmp(&b.biz_date))?;

    let from = NaiveDate::parse_from_str(&earliest.biz_date, "%Y-%m-%d").ok()?;
    let to = NaiveDate::parse_from_str(today, "%Y-%m-%d").ok()?;
    Some((to - from).num_days())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::{yuan_to_cents, Decimalish};

    fn c(s: &str) -> i64 {
        yuan_to_cents(&Decimalish::from(s)).unwrap()
    }

    fn sale(id: i64, biz_date: &str, yuan: &str, return_of: Option<i64>) -> SaleForAlloc {
        SaleForAlloc {
            id,
            biz_date: biz_date.to_string(),
            total_cents: c(yuan),
            return_of_sale_id: return_of,
        }
    }

    fn pay(id: i64, biz_date: &str, yuan: &str) -> PaymentForAlloc {
        PaymentForAlloc {
            id,
            biz_date: biz_date.to_string(),
            amount_cents: c(yuan),
        }
    }

    fn owed(r: &AllocResult, sale_id: i64) -> i64 {
        r.outstanding
            .iter()
            .find(|o| o.sale_id == sale_id)
            .unwrap()
            .outstanding_cents
    }

    #[test]
    fn 一笔收款按日期顺序填满多张单() {
        let r = compute_allocations(
            &[
                sale(1, "2026-08-05", "1000", None),
                sale(2, "2026-08-20", "500", None),
            ],
            &[pay(10, "2026-09-01", "1200")],
        );
        assert_eq!(
            r.allocations,
            vec![
                Allocation {
                    payment_id: 10,
                    sale_id: 1,
                    amount_cents: 100000
                },
                Allocation {
                    payment_id: 10,
                    sale_id: 2,
                    amount_cents: 20000
                },
            ]
        );
        assert_eq!(r.prepaid_cents, 0);
        assert_eq!(owed(&r, 2), c("300"));
    }

    #[test]
    fn 收款不足时最后一张部分核销其余不动() {
        let r = compute_allocations(
            &[
                sale(1, "2026-08-05", "1000", None),
                sale(2, "2026-08-20", "500", None),
            ],
            &[pay(10, "2026-09-01", "600")],
        );
        assert_eq!(r.allocations.len(), 1);
        assert_eq!(owed(&r, 1), c("400"));
        assert_eq!(owed(&r, 2), c("500"));
    }

    #[test]
    fn 超额收款余额成为预收不写核销记录() {
        let r = compute_allocations(
            &[sale(1, "2026-08-05", "3200", None)],
            &[pay(10, "2026-09-01", "3500")],
        );
        assert_eq!(r.prepaid_cents, c("300"));
        let total: i64 = r.allocations.iter().map(|a| a.amount_cents).sum();
        assert_eq!(total, c("3200"));
    }

    #[test]
    fn 多笔收款都用不完时预收是全部剩余之和() {
        let r = compute_allocations(
            &[sale(1, "2026-08-05", "100", None)],
            &[pay(10, "2026-09-01", "300"), pay(11, "2026-09-02", "200")],
        );
        assert_eq!(r.prepaid_cents, c("400"));
    }

    // 这条和下一条是整套设计的立身之本：
    // 业务日期可改 + FIFO 按日期核销 = 增量追加必然算错账龄
    #[test]
    fn 补录一张更早的挂账单重算后它排在最前() {
        let payments = [pay(10, "2026-09-10", "600")];

        let before = compute_allocations(&[sale(2, "2026-09-01", "1000", None)], &payments);
        assert_eq!(aging_days(&before, "2026-09-19"), Some(18));

        // 老板补录了一张 8 月 5 日的单
        let after = compute_allocations(
            &[
                sale(2, "2026-09-01", "1000", None),
                sale(3, "2026-08-05", "500", None),
            ],
            &payments,
        );
        // 收款先填最早的那张，剩下 100 填 9-01 那张
        assert_eq!(
            after.allocations,
            vec![
                Allocation {
                    payment_id: 10,
                    sale_id: 3,
                    amount_cents: 50000
                },
                Allocation {
                    payment_id: 10,
                    sale_id: 2,
                    amount_cents: 10000
                },
            ]
        );
        assert_eq!(
            aging_days(&after, "2026-09-19"),
            Some(18),
            "最早未结清的仍是 9-01 那张"
        );
    }

    #[test]
    fn 把某单的业务日期改早核销顺序跟着变() {
        let payments = [pay(10, "2026-09-10", "500")];
        let before = compute_allocations(
            &[
                sale(1, "2026-09-01", "500", None),
                sale(2, "2026-09-05", "500", None),
            ],
            &payments,
        );
        assert_eq!(before.allocations[0].sale_id, 1);

        let after = compute_allocations(
            &[
                sale(1, "2026-09-08", "500", None),
                sale(2, "2026-09-05", "500", None),
            ],
            &payments,
        );
        assert_eq!(after.allocations[0].sale_id, 2, "现在 2 号单更早，应先被核销");
    }

    #[test]
    fn 同日多单按id稳定排序重算结果可复现() {
        let sales = [
            sale(7, "2026-09-01", "100", None),
            sale(3, "2026-09-01", "100", None),
        ];
        let a = compute_allocations(&sales, &[pay(10, "2026-09-02", "100")]);
        let mut reversed = sales.to_vec();
        reversed.reverse();
        let b = compute_allocations(&reversed, &[pay(10, "2026-09-02", "100")]);
        assert_eq!(a.allocations[0].sale_id, 3);
        assert_eq!(a.allocations, b.allocations, "输入顺序不影响结果");
    }

    #[test]
    fn 作废已被核销的单时释放出的款项流向下一张() {
        let payments = [pay(10, "2026-09-10", "600")];
        let with_both = compute_allocations(
            &[
                sale(1, "2026-08-05", "500", None),
                sale(2, "2026-09-01", "500", None),
            ],
            &payments,
        );
        assert_eq!(with_both.allocations[0].sale_id, 1);

        // 1 号单作废 —— 作废单不进输入
        let after = compute_allocations(&[sale(2, "2026-09-01", "500", None)], &payments);
        assert_eq!(
            after.allocations,
            vec![Allocation {
                payment_id: 10,
                sale_id: 2,
                amount_cents: 50000
            }]
        );
        assert_eq!(after.prepaid_cents, c("100"), "多出来的 100 成为预收");
    }

    #[test]
    fn 退货负单抵减它对应的原单() {
        let r = compute_allocations(
            &[
                sale(1, "2026-09-01", "1000", None),
                sale(2, "2026-09-05", "-400", Some(1)),
            ],
            &[pay(10, "2026-09-10", "600")],
        );
        assert_eq!(r.allocations.len(), 1);
        assert_eq!(r.allocations[0].amount_cents, c("600"));
        assert_eq!(owed(&r, 1), 0, "1000 − 400 − 600 = 0");
    }

    #[test]
    fn 退货把欠款抵成负数时产生预收() {
        let r = compute_allocations(
            &[
                sale(1, "2026-09-01", "1000", None),
                sale(2, "2026-09-05", "-1000", Some(1)),
            ],
            &[pay(10, "2026-09-10", "200")],
        );
        assert_eq!(r.allocations.len(), 0, "没有欠款可核销");
        assert_eq!(r.prepaid_cents, c("200"));
    }

    #[test]
    fn 幂等连续重算两次结果完全一致() {
        let sales = [
            sale(1, "2026-08-05", "1000", None),
            sale(2, "2026-09-01", "500", None),
        ];
        let payments = [pay(10, "2026-09-10", "1200")];
        assert_eq!(
            compute_allocations(&sales, &payments),
            compute_allocations(&sales, &payments)
        );
    }

    #[test]
    fn 没有欠款时账龄为空() {
        let r = compute_allocations(
            &[sale(1, "2026-09-01", "500", None)],
            &[pay(10, "2026-09-02", "500")],
        );
        assert_eq!(aging_days(&r, "2026-09-19"), None);
    }
}

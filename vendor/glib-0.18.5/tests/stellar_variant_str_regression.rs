//! Regression coverage for the upstream VariantStrIter out-pointer fix.
//! Must also run with --release: optimizations exposed the original UB.
use glib::{prelude::*, Variant};

fn fixture() -> Variant {
    ["first", "", "æøå", "last"].to_variant()
}

#[test]
fn stellar_variant_str_forward_and_reverse() {
    let value = fixture();
    assert_eq!(value.array_iter_str().unwrap().collect::<Vec<_>>(), ["first", "", "æøå", "last"]);
    assert_eq!(value.array_iter_str().unwrap().rev().collect::<Vec<_>>(), ["last", "æøå", "", "first"]);
}

#[test]
fn stellar_variant_str_nth_last_and_mixed_ends() {
    let value = fixture();
    assert_eq!(value.array_iter_str().unwrap().nth(2), Some("æøå"));
    assert_eq!(value.array_iter_str().unwrap().nth_back(1), Some("æøå"));
    assert_eq!(value.array_iter_str().unwrap().last(), Some("last"));
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.next_back(), Some("æøå"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}

#[test]
fn stellar_variant_str_empty_and_repeated_access() {
    let empty: Vec<&str> = Vec::new();
    let value = empty.to_variant();
    assert_eq!(value.array_iter_str().unwrap().next(), None);
    let value = fixture();
    for _ in 0..1024 {
        assert_eq!(value.array_iter_str().unwrap().nth(2), Some("æøå"));
    }
}

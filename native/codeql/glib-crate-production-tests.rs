use glib::prelude::*;
use glib::variant::ToVariant;
use glib::{Object, PtrSlice};

#[test]
fn real_crate_string_iterator_handles_unicode_empty_and_long_arrays() {
    for values in [vec![], vec![String::new(), "Stellar ø🔐".into(), "x".repeat(8192)]] {
        let variant = values.to_variant();
        let actual: Vec<&str> = variant.array_iter_str().unwrap().collect();
        assert_eq!(actual, values);
        let reverse: Vec<&str> = variant.array_iter_str().unwrap().rev().collect();
        assert_eq!(reverse, values.iter().rev().collect::<Vec<_>>());
    }
}

#[test]
fn real_crate_mixed_iteration_and_overflow_preserve_bounds() {
    for length in 0..64 {
        let values: Vec<String> = (0..length).map(|index| format!("item-{index}")).collect();
        let variant = values.to_variant();
        let mut iter = variant.array_iter_str().unwrap();
        let mut model: std::collections::VecDeque<&str> = values.iter().map(String::as_str).collect();
        while !model.is_empty() {
            assert_eq!(iter.len(), model.len());
            assert_eq!(iter.next(), model.pop_front());
            assert_eq!(iter.next_back(), model.pop_back());
        }
        assert_eq!(iter.next(), None);
        assert_eq!(iter.next_back(), None);
        assert_eq!(variant.array_iter_str().unwrap().nth(usize::MAX), None);
        assert_eq!(variant.array_iter_str().unwrap().nth_back(usize::MAX), None);
    }
}

#[test]
fn pointer_slice_truncate_and_clear_release_only_removed_objects() {
    let first = Object::new::<Object>();
    let second = Object::new::<Object>();
    let mut slice: PtrSlice<Object> = vec![first.clone(), second.clone()].into();
    assert_eq!(first.ref_count(), 2);
    assert_eq!(second.ref_count(), 2);
    slice.truncate(1);
    assert_eq!(first.ref_count(), 2);
    assert_eq!(second.ref_count(), 1);
    slice.truncate(1);
    assert_eq!(first.ref_count(), 2);
    slice.push(second.clone());
    assert_eq!(second.ref_count(), 2);
    slice.clear();
    assert_eq!(first.ref_count(), 1);
    assert_eq!(second.ref_count(), 1);
    assert!(slice.is_empty());
}

#[test]
fn pointer_slice_drop_and_pop_preserve_exact_ownership() {
    let owners: Vec<Object> = (0..24).map(|_| Object::new::<Object>()).collect();
    let weak: Vec<_> = owners.iter().map(|object| object.downgrade()).collect();
    let mut slice: PtrSlice<Object> = owners.iter().cloned().collect();
    drop(owners);
    slice.truncate(7);
    for (index, object) in weak.iter().enumerate() {
        assert_eq!(object.upgrade().is_some(), index < 7);
    }
    let popped = slice.pop().unwrap();
    assert!(weak[6].upgrade().is_some());
    drop(popped);
    assert!(weak[6].upgrade().is_none());
    drop(slice);
    assert!(weak.iter().all(|object| object.upgrade().is_none()));
}

#[test]
fn native_test_loads_glib_and_gobject_without_gio() {
    let maps = std::fs::read_to_string("/proc/self/maps").unwrap();
    assert!(maps.contains("libglib-2.0.so"));
    assert!(maps.contains("libgobject-2.0.so"));
    assert!(!maps.contains("libgio-2.0.so"));
}

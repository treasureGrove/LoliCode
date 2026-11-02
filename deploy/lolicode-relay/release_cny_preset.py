#!/usr/bin/env python3
"""Publish the CNY/Credit defaults while preserving saved prices and history."""
import release_usd_preset


if __name__ == '__main__':
    release_usd_preset.PREVIOUS = 'credit-20261030T075824Z'
    release_usd_preset.main()

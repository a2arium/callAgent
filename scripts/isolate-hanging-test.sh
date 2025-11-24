#!/bin/bash
# Script to isolate which test file is causing the hang
# Usage: ./scripts/isolate-hanging-test.sh

echo "Isolating hanging test..."
echo "This will run each test file individually to find which one hangs"
echo ""

# Get all test files
TEST_FILES=$(find packages/core/tests -name "*.test.ts" -o -name "*.test.js" | sort)

HANGING_TESTS=()

for test_file in $TEST_FILES; do
    echo "Testing: $test_file"
    
    # Run with timeout (10 seconds should be enough for most tests)
    timeout 30 yarn test "$test_file" > /tmp/test_output.log 2>&1
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 124 ]; then
        echo "  ❌ TIMEOUT - This test file hangs!"
        HANGING_TESTS+=("$test_file")
    elif [ $EXIT_CODE -eq 0 ]; then
        echo "  ✓ Passed"
    else
        echo "  ✗ Failed (but didn't hang)"
    fi
done

echo ""
echo "=========================================="
if [ ${#HANGING_TESTS[@]} -eq 0 ]; then
    echo "No hanging tests found!"
else
    echo "Hanging test files found:"
    for test in "${HANGING_TESTS[@]}"; do
        echo "  - $test"
    done
fi


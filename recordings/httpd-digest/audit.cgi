#!/bin/sh
# The auditors' extract totals for the one period of the gateway's data, as a pipe line.
printf 'Content-Type: text/plain\n\n'
case "$QUERY_STRING" in
period=202610) printf 'OK|202610|3|173457\n' ;;
*) printf 'ERROR|E_NOPERIOD|no extract for %s\n' "${QUERY_STRING#period=}" ;;
esac

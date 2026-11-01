#!/usr/bin/perl
# CGI.pm owns all query splitting, unescaping and repeated-value selection. The tiny report
# handler supplies only the gateway service page's synthetic balance/session-error outcomes.
use strict;
use warnings;
use CGI;
use HTTP::Daemon;
use HTTP::Response;

my $server = HTTP::Daemon->new(
    LocalAddr => '0.0.0.0', LocalPort => 8080, ReuseAddr => 1,
) or die "listen: $!";

while (my $connection = $server->accept) {
    while (my $request = $connection->get_request) {
        if ($request->method ne 'GET' || $request->uri->path ne '/cgi-bin/report.cgi') {
            $connection->send_response(HTTP::Response->new(404));
            next;
        }
        my $query = CGI->new($request->uri->query // '');
        my $session = scalar $query->param('session');
        my $report = scalar $query->param('report');
        my $account = scalar $query->param('account');
        my $body = !defined($session) || $session ne 'sso+opaque;1='
            ? "ERROR|E_SESSION|session expired or unknown\n"
            : !defined($report) || $report ne 'balance'
                ? "ERROR|E_PARAM|unknown report\n"
                : !defined($account) || $account ne '00012345'
                    ? "ERROR|E_NOACCT|unknown account\n"
                    : "OK|00012345|123450|20261115\n";
        $connection->send_response(HTTP::Response->new(
            200, 'OK', ['Content-Type' => 'text/plain'], $body,
        ));
    }
    $connection->close;
}

#!/usr/bin/perl
# The gateway's five XML-RPC methods served by XMLRPC::Lite's HTTP daemon, over the synthetic data
# in data.json. XMLRPC::Lite dispatches `report.count` to the package `report` and its sub `count`.
# Each handler returns plain scalars where the serializer's guess gives the documented type (counts
# and ids as integers, amounts formatted with two decimals, dates in the module's own pattern), and
# XMLRPC::Data's typed values where a guess would be wrong: the serializer turns any text holding a
# character outside printable ASCII into base64, and an all-digit account into an integer.
# Application errors are SOAP::Fault objects with the gateway's numbers.
use strict;
use warnings;

use Encode qw(encode);
use JSON::PP;
use List::Util qw(sum0);
use XMLRPC::Transport::HTTP;

our $data = do {
    open my $file, '<', '/srv/data.json' or die "data.json: $!";
    local $/;
    JSON::PP->new->utf8->decode(<$file>);
};

sub units { sprintf '%.2f', $_[0] / 100 }
sub text { XMLRPC::Data->type(string => $_[0]) }
sub refuse { die SOAP::Fault->faultcode($_[0])->faultstring($_[1]) }

# The month-end extract as the mainframe writes it: 64-byte ISO-8859-1 records.
sub extract_bytes {
    my ($period, $extract) = @_;
    my @records = @{ $extract->{records} };
    my @lines = (sprintf 'HMONTHEND%-6s%-8s%41s', $period, $extract->{runDate}, '');
    push @lines, sprintf 'D%-8s%-30s%011d%-8s%1s%5s',
        @{$_}{qw(account title cents due status)}, ''
        for @records;
    push @lines, sprintf 'T%06d%013d%44s', scalar @records,
        sum0(map { $_->{cents} } @records), '';
    return encode('iso-8859-1', join '', @lines);
}

package system;

sub listMethods {
    [qw(system.listMethods report.count account.title invoice.get extract.fetch)];
}

package report;

sub count {
    my (undef, $period) = @_;
    my $extract = $main::data->{extracts}{$period}
        or main::refuse(404, "no extract for $period");
    scalar @{ $extract->{records} };
}

package account;

sub title {
    my (undef, $number) = @_;
    my ($account) = grep { $_->{account} eq $number } @{ $main::data->{accounts} };
    main::refuse(404, "no such account $number") unless $account;
    main::text($account->{title});
}

package invoice;

sub get {
    my (undef, $id) = @_;
    my ($invoice) = grep { $_->{id} == $id } @{ $main::data->{invoices} };
    main::refuse(404, "no such invoice $id") unless $invoice;
    {
        id      => $invoice->{id},
        account => main::text($invoice->{account}),
        amount  => main::units($invoice->{cents}),
        paid    => XMLRPC::Data->type(boolean => $invoice->{paid} ? 1 : 0),
        issued  => $invoice->{issued},
        settled => $invoice->{settled},
        lines   => [
            map { { text => main::text($_->{text}), amount => main::units($_->{cents}) } }
                @{ $invoice->{lines} }
        ],
    };
}

package extract;

sub fetch {
    my (undef, $period) = @_;
    my $extract = $main::data->{extracts}{$period}
        or main::refuse(404, "no extract for $period");
    XMLRPC::Data->type(base64 => main::extract_bytes($period, $extract));
}

package main;

XMLRPC::Transport::HTTP::Daemon->new(LocalPort => 8080, ReuseAddr => 1)
    ->dispatch_to(qw(system report account invoice extract))
    ->handle;

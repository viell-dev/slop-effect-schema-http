#!/usr/bin/perl
# The gateway's five XML-RPC methods served by Frontier::Daemon and encoded by Frontier::RPC2, over
# the synthetic data in data.json. Each handler returns the value the way a maintainer of the
# module's 0.07 release would: plain scalars where Frontier::RPC2's guess gives the documented type
# (counts and ids as integers, amounts formatted with two decimals, text), and the module's typed
# constructors where a guess would be wrong (an all-digit account as a string, booleans, dates,
# base64). A handler's `die` is the only way to report an error through Frontier::Daemon.
use strict;
use warnings;

use Encode qw(encode);
use Frontier::Daemon;
use Frontier::RPC2;
use JSON::PP;
use List::Util qw(sum0);
use MIME::Base64 qw(encode_base64);

my $data = do {
    open my $file, '<', '/srv/data.json' or die "data.json: $!";
    local $/;
    JSON::PP->new->utf8->decode(<$file>);
};
my $coder = Frontier::RPC2->new;

sub units { sprintf '%.2f', $_[0] / 100 }

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

my %methods = (
    'system.listMethods' => sub {
        [qw(system.listMethods report.count account.title invoice.get extract.fetch)];
    },
    'report.count' => sub {
        my ($period) = @_;
        my $extract = $data->{extracts}{$period} or die "no extract for $period\n";
        scalar @{ $extract->{records} };
    },
    'account.title' => sub {
        my ($number) = @_;
        my ($account) = grep { $_->{account} eq $number } @{ $data->{accounts} };
        die "no such account $number\n" unless $account;
        $account->{title};
    },
    'invoice.get' => sub {
        my ($id) = @_;
        my ($invoice) = grep { $_->{id} == $id } @{ $data->{invoices} };
        die "no such invoice $id\n" unless $invoice;
        {
            id      => $invoice->{id},
            account => $coder->string($invoice->{account}),
            amount  => units($invoice->{cents}),
            paid    => $coder->boolean($invoice->{paid} ? 1 : 0),
            issued  => $coder->date_time($invoice->{issued}),
            settled => $coder->date_time($invoice->{settled}),
            lines   => [
                map { { text => $_->{text}, amount => units($_->{cents}) } }
                    @{ $invoice->{lines} }
            ],
        };
    },
    'extract.fetch' => sub {
        my ($period) = @_;
        my $extract = $data->{extracts}{$period} or die "no extract for $period\n";
        $coder->base64(encode_base64(extract_bytes($period, $extract)));
    },
);

Frontier::Daemon->new(LocalPort => 8080, ReuseAddr => 1, methods => \%methods)
    or die "cannot listen: $!";

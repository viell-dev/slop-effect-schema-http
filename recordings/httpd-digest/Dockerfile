# httpd 2.4.68 with mod_auth_digest and AuthDigestQop none, standing in for Apache 1.3's mod_digest.
# httpd 2.4.69 refuses the directive ("AuthDigestQop is deprecated: only 'auth' is supported"), so
# 2.4.68 is the last release that can answer RFC 2069 Digest at all.
FROM httpd:2.4.68@sha256:03f858efb82c25cb0f9962946615cdcdaf26927cb971722149b563197cfd0fdd
COPY httpd.conf /usr/local/apache2/conf/httpd.conf
COPY audit.cgi /usr/local/apache2/admin/audit.cgi
# The synthetic auditor `auditor` with the password `Secr3t!`, in htdigest's format.
RUN chmod 755 /usr/local/apache2/admin/audit.cgi \
 && printf 'auditor:Reporting Gateway:%s\n' \
      "$(printf '%s' 'auditor:Reporting Gateway:Secr3t!' | md5sum | cut -d ' ' -f 1)" \
      > /usr/local/apache2/conf/auditors.digest
EXPOSE 80

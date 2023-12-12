import configparser
import urllib.request
import os
import stat

url = 'https://raw.githubusercontent.com/NavyStack/SynologyCloudFlareDDNS-WithMultiple/master/cloudflare.php'

config = configparser.ConfigParser()
config.read('/etc.defaults/ddns_provider.conf')

for section in config.sections():
    if section.startswith('Cloudflare'):
        config.remove_section(section)

for i in range(1, 11):
    section_name = f'Cloudflare {i:02d}' 
    config[section_name] = {}
    config[section_name]['modulepath'] = f'/usr/syno/bin/ddns/cloudflare {i:02d}.php'
    config[section_name]['queryurl'] = 'https://www.cloudflare.com/'

    target_file = f'/usr/syno/bin/ddns/cloudflare {i:02d}.php'
    urllib.request.urlretrieve(url, target_file)
    os.chmod(target_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)

with open('/etc.defaults/ddns_provider.conf', 'w') as configfile:
    config.write(configfile)
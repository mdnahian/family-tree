output "droplet_ip" {
  value = digitalocean_droplet.bdtree.ipv4_address
}

output "reserved_ip" {
  value = digitalocean_reserved_ip.bdtree.ip_address
}

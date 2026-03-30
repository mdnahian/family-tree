output "droplet_ip" {
  value = digitalocean_droplet.family-tree.ipv4_address
}

output "reserved_ip" {
  value = digitalocean_reserved_ip.family-tree.ip_address
}
